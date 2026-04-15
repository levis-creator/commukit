# 06 — Security & Privacy

## Authentication

SIP softphones authenticate against Kamailio using **SIP DIGEST**, the
standard challenge-response scheme defined in RFC 3261 and RFC 2617.
Flow:

1. Softphone sends `REGISTER` with no credentials
2. Kamailio responds `401 Unauthorized` with a nonce
3. Softphone re-sends `REGISTER` with
   `HA1 = MD5(username:realm:password)` combined with the nonce
4. Kamailio verifies against the stored HA1 in the `subscriber` table
5. On match, Kamailio records the contact in the `location` table

**comms-service writes to the `subscriber` table**; Kamailio reads from
it. The separation means credentials can be rotated without touching
Kamailio's config.

Passwords are stored in two forms in `subscriber`:
- `password` — plain text (used by some legacy SIP clients)
- `ha1` — `MD5(username:realm:password)`
- `ha1b` — `MD5(username@realm:realm:password)` (used by a few clients)

Both hashes are precomputed by `SipService.upsertKamailioSubscriber`
before the row is inserted, so Kamailio never has to compute them at
REGISTER time.

## Credential Storage

- **comms-service's `communication_users.sipPassword`** holds the plain
  text password so the consumer-facing session response can return it
  to the softphone user without re-deriving it from a hash.
- **Kamailio's `subscriber.password`** holds the same plain text value.
  You *can* clear this column after the HA1 hashes are written, and
  Kamailio will still authenticate successfully — most deployments
  leave it in place for operator debugging.
- **Never log the password**. Neither comms-service nor Kamailio log
  the plaintext value by default. If you customize Kamailio's logging,
  make sure you don't enable `siptrace` at debug level without
  redacting the Authorization header.

## Credential Rotation

Right now credentials are minted once and reused. To rotate a user's
password:

1. DELETE the row from `communication_users.sipPassword` (set to NULL)
2. Call `POST /internal/v1/users/sip-credentials` again — this mints a
   fresh password and upserts the new `subscriber` row
3. Hand the new credentials to the user

Bulk rotation (e.g. after a leak) is currently a manual operation. A
future improvement would add a `POST /internal/v1/users/:id/rotate-sip`
endpoint that wraps the above sequence.

## Transport Security

By default, SIP runs on **UDP/5060 and TCP/5060 without TLS**. This
means:
- REGISTER credentials are in the clear (well — hashed, not plain text,
  but the HA1 hash can be reused for future authentications)
- INVITE bodies and SDPs are in the clear
- RTP media (between the softphone and whoever is on the other end) is
  in the clear

For production deployments where SIP traffic crosses untrusted
networks, **enable SIP-TLS**:

1. Generate or obtain a TLS cert for the SIP domain
2. Drop it into the `kamailio-tls` Docker volume
3. Edit `infra/kamailio/kamailio.cfg` to add `listen=tls:0.0.0.0:5061`
4. Set `SIP_TRANSPORT=tls` and `SIP_REGISTRAR_PORT=5061` in `.env`
5. Configure softphones to use TLS transport

TLS protects the REGISTER, INVITE, and signalling. It does NOT
encrypt the RTP media — for that you need SRTP, which Kamailio can
negotiate but only works end-to-end when both sides (softphone and
the SIP bridge's destination) support it.

**Inside a Docker network** with no external exposure, UDP/5060 is
fine — the threat model is that nothing outside the `comms-network`
bridge can see the traffic in the first place. TLS matters when you
expose Kamailio's port 5060 on the host and users connect from the
public internet.

## Network Exposure

By default `docker-compose.yml` binds Kamailio to the host on port
5060. For a production deployment you have three reasonable shapes:

1. **Internal only** — remove the host port mapping. Softphones must
   run inside the Docker network (rare).
2. **LAN only** — bind to a specific interface (`127.0.0.1:5060:5060`
   or a private RFC1918 address). Softphones must be on that network.
3. **Public internet with TLS** — bind to all interfaces with TLS
   enforced and Kamailio's `pike` rate limit tuned down. Put a
   firewall in front that only allows traffic from expected regions.

Option 2 is the right default for most deployments.

## Rate Limiting

Kamailio's `pike` module is enabled in [kamailio.cfg](../../infra/kamailio/kamailio.cfg)
with:
- `sampling_time_unit = 2` (check window of 2 seconds)
- `reqs_density_per_unit = 20` (max 20 requests per 2s window per source)
- `remove_latency = 4` (ban offenders for 4 seconds of inactivity)

This blocks brute-force REGISTER attempts and friendly-scanner noise
without impacting legitimate users. Increase `remove_latency` for
stronger deterrence (say, 300 for 5-minute bans) if your logs show
sustained attacks.

## Session Invalidation

Three ways a SIP user's access can be cut off:

1. **`invalidate-session`** — blocks new calls to a specific room but
   keeps the softphone's REGISTER valid.
2. **`deprovisionUser(username)`** — deletes the row from Kamailio's
   `subscriber` table. Existing registrations survive until their TTL
   expires (~5 min), new registrations are rejected.
3. **`closeRoom`** — moves the room to `CLOSED`; any future
   `SIP_CALL_*` rejection audits refer back to the closed state.

For a "immediately log out this user everywhere" flow, combine
approach (2) with a manual DELETE against the `location` table:

```sql
DELETE FROM location WHERE username = 'comms_7f3c1b2e9a4d4b56';
DELETE FROM subscriber WHERE username = 'comms_7f3c1b2e9a4d4b56';
```

## Stuck Calls and Abuse

The `SipBridgeService` reaper runs every minute and kills any call
whose age exceeds `SIP_MAX_CALL_SECONDS` (default 7200s = 2 hours).
This prevents a misbehaving softphone from holding a Janus handle
indefinitely. Adjust the cap in `.env` for deployments with longer
expected call durations.

## Audit Trail

Every SIP event writes an immutable row to `communication_audit_logs`
(see [`02-api-flow.md`](02-api-flow.md) for the full key list).
Specifically:

- `SIP_BRIDGE_REGISTERED` / `_FAILED` — bridge lifecycle (logged, not
  persisted to DB — no room FK to attach them to)
- `SIP_CALL_BRIDGED` — successful inbound call
- `SIP_CALL_REJECTED_*` — rejected inbound calls, with a reason field
- `SIP_CALL_HUNG_UP` — normal hangup, includes `durationSeconds`
- `SIP_CALL_TIMEOUT_REAPED` — reaper killed a stuck call

This log is the primary forensic trail when investigating "why did my
softphone call fail?" Search by `sipUsername`, `callId`, or
`contextId` depending on what you know.

## What Comms Does NOT Protect Against

- **Softphone compromise.** If an attacker gets a user's SIP password
  off the user's device, they can register that user's softphone from
  anywhere. Treat SIP credentials like any other API credential —
  users should be told to keep their softphone installation on a
  trusted device.
- **Reused passwords across capabilities.** The SIP password is
  separate from the Matrix password by design. A compromised Matrix
  access token doesn't automatically compromise SIP and vice versa.
- **Network-layer attacks.** TLS terminations, certificate
  authorities, firewalls, and VPN configuration are outside the scope
  of this service. If your threat model includes a hostile network
  operator, you need defence in depth at the network layer too.

## Known Limitations (v1)

- **No forced hangup from the consumer side without calling the SIP
  hangup path.** A future `POST /internal/v1/sip/calls/:callId/hangup`
  endpoint will wrap `SipBridgeService.hangupSipCall` for admin use.
- **No audit of raw REGISTER attempts.** Kamailio logs these to
  stderr; adding them to `communication_audit_logs` would require a
  Kamailio → comms event bridge that doesn't exist yet.
- **Media bridging is a stub in v1** — see the class-level JSDoc in
  `SipBridgeService` for the rtpengine-integrated v1.1 follow-up.
