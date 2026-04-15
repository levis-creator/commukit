# Legal & Scope Disclaimers

## NOT A PSTN GATEWAY

This SIP integration **does not connect to the public phone network**.

- You **cannot** dial real phone numbers (e.g. `+254 700 123 456`).
- Real phone numbers **cannot** dial in.
- No SIP trunk provider is configured.
- No per-minute charges are ever incurred to any party.

This is a purely internal SIP registrar — free SIP softphones
authenticate with a Kamailio sidecar inside your Docker network and
bridge into Janus AudioBridge rooms the same way browser clients do.
The two worlds (WebRTC and SIP) meet inside Janus; neither one ever
touches the public telephone network.

If you need real phone connectivity, you need a paid SIP trunk
(Telnyx, Twilio, Bandwidth, Africa's Talking, or similar) and a
different architecture. That is a separate v2 feature and is not
implemented.

## NO EMERGENCY SERVICES

This system is **NOT for emergency calls**:

- ❌ 911 (United States / Canada)
- ❌ 999 (Kenya / United Kingdom)
- ❌ 112 (European Union / most of Africa)
- ❌ Any other emergency number

Do not rely on this service for any situation where life, health, or
property are at risk. Even if your softphone is registered and working
inside your organization, dialing an emergency number will fail — the
call will be routed to the internal registrar, not to emergency
dispatch, and will be rejected with a 404.

Your consumer app UI should make this crystal clear to end users in
any region where emergency services are a reasonable expectation of a
"phone-like" interface. A banner or persistent notice is appropriate.

## Recording

Recording is **not supported in v1**. Calls made via SIP softphones
are not captured on the server side.

If you add recording later, be aware that many jurisdictions require
two-party consent for recording voice calls. Talk to your legal team
before enabling — the rules vary significantly by region, even within
a single country.

## Caller-ID

Because this system doesn't touch the PSTN, there's no traditional
caller ID. The "From" header of each call carries the user's SIP
username (e.g. `comms_7f3c1b2e9a4d4b56@comms.local`) which your
consumer app can map back to the domain user via the
`communication_users` table. This mapping is for internal display
only; it has no meaning outside your deployment.

## Data Storage

- **SIP passwords** are stored in plain text in `communication_users.sipPassword`
  and in Kamailio's `subscriber.password` column, plus as HA1 / HA1B
  hashes in `subscriber.ha1` / `.ha1b`. This is standard SIP DIGEST
  practice — the HA1 hash is the credential Kamailio actually verifies
  at register time. If your threat model treats plaintext SIP passwords
  as unacceptable, you can clear the `password` column after the hashes
  are written (Kamailio only needs the hashes) and store the plaintext
  value only encrypted in comms-service's database.
- **SIP traffic** over UDP / TCP is not encrypted by default. Enable
  TLS transport if your users are outside your trusted network.
- **Call metadata** (who called what room when) is stored in
  `communication_audit_logs` with the same retention policy as the
  other capabilities.

## Roadmap Notes

Real PSTN connectivity, SIP federation between deployments, inbound
DID routing, recording, SIP-over-WebSocket, and video over SIP are all
**explicitly out of scope for v1**. If any of these become necessary,
they will each need their own dedicated plan and implementation — they
are not "add later on top of what we have". The core v1 deliberately
stays small so it's easy to reason about and easy to audit.
