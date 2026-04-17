# 07 — Troubleshooting

## Symptom → Cause Table

| Symptom | Likely cause |
|---|---|
| `/health` → `sip: "disabled"` | `SIP_ENABLED=false` in `.env` or the `sip` profile isn't in `COMPOSE_PROFILES`. |
| `/health` → `sip: "unregistered"` | Kamailio or Janus isn't reachable, or `SIP_BRIDGE_PASSWORD` is blank. Check `docker compose logs comms-service` for the init retry loop. |
| `/users/sip-credentials` → 503 | Same as above — either SIP is disabled or credentials provisioning failed. Check response body for the `reason` field. |
| Session response `sip.status: "unavailable"` with `reason: "SIP disabled"` | Module not loaded — flip `SIP_ENABLED=true` and restart. |
| Session response `sip: null` for an `IN_PERSON` or `HYBRID` room | The room wasn't provisioned with an AudioBridge. Check `communication_rooms.audioRoomId`. |
| Session response `sip: null` for a `REMOTE` or `CHAT` room | Expected — these room modes have no AudioBridge, so SIP doesn't apply. |
| Softphone "Registration failed / 401 Unauthorized" | Wrong username or password. Copy them again exactly — SIP DIGEST is case-sensitive. |
| Softphone "Registration failed / 403 Forbidden" | `subscriber` row missing from Kamailio DB. Re-call `POST /users/sip-credentials` to reprovision. |
| Softphone "Registration failed / timeout" | Kamailio unreachable. Check `docker compose ps comms-kamailio` and `docker compose logs comms-kamailio`. |
| Softphone says "Registered" but dialing the room URI gets 404 | Kamailio rejected the INVITE because the URI format didn't match `room-*@<domain>`. Check the URI exactly matches `sip:room-<contextId>@<domain>`. |
| Dialing the room URI gets 503 Service Unavailable | The Janus SIP bridge isn't registered with Kamailio. Check `/health` for `sip: "registered"`. |
| Dialing works, call accepted, but no audio | **Expected in v1** — media bridging requires rtpengine (see `01-architecture.md` under "Pending"). The call connects cleanly but RTP doesn't flow. This is the v1.1 follow-up. |
| Audit log shows `SIP_CALL_REJECTED_UNKNOWN_USER` | The From URI on the INVITE doesn't match any `communication_users.sipUsername`. Either the softphone registered with the wrong creds, or credentials were rotated between REGISTER and INVITE. |
| Audit log shows `SIP_CALL_REJECTED_ROOM_NOT_FOUND` | The `X-Comms-Context-Id` header didn't match any `communication_rooms.contextId` for the user's `appId`. Check the room was provisioned under the right `appId`. |
| Audit log shows `SIP_CALL_REJECTED_NOT_MEMBER` | User is provisioned in comms but hasn't been authorized for this specific room. Call `authorize-user` first. |
| Audit log shows `SIP_CALL_REJECTED_SESSION_INVALIDATED` | Expected — the user was previously kicked/invalidated from this room. |
| `SIP_CALL_TIMEOUT_REAPED` appearing in logs | Normal for calls that ran past `SIP_MAX_CALL_SECONDS`. Lower the cap if calls are getting reaped too aggressively; raise it if long legitimate calls are being killed. |
| Long-poll errors in logs, session keeps reinitializing | Janus session timing out (default 60s) because keepalive failed. Usually means Janus itself is unhealthy — check `comms-janus` logs. |

## Diagnostics Checklist

When SIP is broken for a specific user:

1. **Health check** — `curl http://localhost:3014/health`. You need
   `janus: "connected"` AND `sip: "registered"` for end-to-end SIP.
2. **Confirm credentials exist** — query `communication_users`:
   ```sql
   SELECT sipUsername, sipPassword IS NOT NULL AS has_password
   FROM communication_users
   WHERE domainUserId = '<user>';
   ```
3. **Confirm Kamailio has the subscriber row** —
   ```sql
   SELECT username, domain, ha1 IS NOT NULL AS has_hash
   FROM subscriber
   WHERE username = '<sipUsername>';
   ```
4. **Check the active REGISTER** —
   ```sql
   SELECT username, contact, expires FROM location
   WHERE username = '<sipUsername>';
   ```
   Empty result = softphone isn't registered right now.
5. **Inspect audit log** for the user:
   ```sql
   SELECT action, metadata, createdAt
   FROM communication_audit_logs
   WHERE action LIKE 'SIP_%'
   ORDER BY createdAt DESC LIMIT 20;
   ```
6. **Kamailio logs** — `docker compose logs comms-kamailio | grep -i register`.
7. **Janus logs** — `docker compose logs comms-janus | grep -i sip`.
8. **comms-service logs** — look for `SIP bridge` and `SipBridgeService`
   log lines. The init retry loop logs every attempt.

## Common Setup Mistakes

- **Forgetting to add `sip` to `COMPOSE_PROFILES`.** You set
  `SIP_ENABLED=true`, restart comms-service, but Kamailio isn't running
  because the compose profile didn't include it. Symptom: `/health`
  shows `sip: "unregistered"` forever.
- **Different `SIP_DOMAIN` in Kamailio config vs. comms-service.**
  Kamailio authenticates against `(username, domain)` and comms
  provisions with `(username, domain)` — if they don't match, every
  REGISTER fails with 401. Make sure `SIP_DOMAIN` in `.env` matches the
  value Kamailio's config expects.
- **Running old Kamailio without `init.sql` applied.** First-boot
  scripts only run when the postgres volume is empty. If you spun up
  the stack before the SIP work and then enabled SIP, you need to
  manually run `infra/kamailio/init.sql` against the existing database.
- **Using an underscore in the SIP username.** Some legacy softphones
  reject usernames with underscores. `comms_<id>` is widely supported
  but if a specific softphone refuses, see whether it treats the
  underscore as special in the URI.
- **NAT between softphone and Kamailio.** If the softphone is behind
  NAT relative to comms-service, REGISTER works but the contact URI
  points at a private address and subsequent INVITEs fail. Enable
  `nathelper` in Kamailio or require all softphones to be on the same
  network.

## Debugging the Long-Poll

If `SIP_BRIDGE_REGISTERED` never appears in the audit log, the bridge
is stuck somewhere in the init loop. Useful log markers:

- `SipBridgeService: SIP bridge initialization sent` — bridge sent
  REGISTER; waiting for async response
- `SipBridgeService: SIP bridge REGISTERed as …` — success
- `SipBridgeService: SIP session expired` — Janus dropped the session;
  reinit in 1s
- `SipBridgeService: SIP bridge init failed (…); retrying in Xms` —
  init failed at some step before REGISTER was sent

If you see init failures repeatedly:
- Check `JANUS_HTTP_URL` reachability from comms-service
- Check `SIP_BRIDGE_PASSWORD` is set
- Check Kamailio has a `subscriber` row for the bridge user (username
  from `SIP_BRIDGE_USERNAME`, default `janus`)

## Reference Files

| File | What it does |
|---|---|
| `src/sip/sip.service.ts` | Credential issuance + Kamailio subscriber writes |
| `src/sip/sip-bridge.service.ts` | Long-lived Janus SIP bridge, long-poll worker, reaper |
| `src/janus/janus.service.ts` | Low-level Janus HTTP helpers (`sipCreateSession`, `sipSendMessage`, `sipLongPoll`) |
| `infra/kamailio/kamailio.cfg` | SIP registrar + routing config |
| `infra/kamailio/init.sql` | Postgres schema for `subscriber` + `location` |
| `infra/janus/janus.plugin.sip.jcfg` | Janus SIP plugin config |
