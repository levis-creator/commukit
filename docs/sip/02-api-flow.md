# 02 — API Flow

All endpoints require an internal JWT with `aud: "communications-service"`.
SIP routes return `503 Service Unavailable` when `SIP_ENABLED=false`.

## 1. Get SIP Credentials via `authorize-user` (in-room flow)

SIP credentials are included in the standard `authorize-user` response
for rooms with an AudioBridge (`IN_PERSON` or `HYBRID` mode). The
credentials are issued lazily on first call and persisted.

```
POST /internal/v1/rooms/:contextId/authorize-user
```

Request:
```json
{
  "appId": "myapp",
  "contextType": "MEETING",
  "domainUserId": "<user-uuid>",
  "displayName": "Jane Doe",
  "roles": ["PARTICIPANT"]
}
```

Response (new `sip` field):
```json
{
  "roomId": "<comms-room-uuid>",
  "status": "ACTIVE",
  "chat":       { "status": "available", "...": "..." },
  "audioBridge":{ "status": "available", "...": "..." },
  "videoRoom":  null,
  "sip": {
    "status": "available",
    "username": "comms_7f3c1b2e9a4d4b56",
    "password": "5f4dcc3b5aa765d61d8327deb882cf9904...",
    "registrar": "sip:comms-kamailio:5060;transport=udp",
    "domain": "comms.local",
    "transport": "udp",
    "roomUri": "sip:room-<contextId>@comms.local"
  },
  "modeImmutable": true
}
```

When SIP is disabled or the user is in a `REMOTE` / `CHAT` room,
`sip` is either `null` (no AudioBridge for this room) or
`{ "status": "unavailable", "reason": "SIP disabled" }`.

## 2. Get SIP Credentials Standalone (pre-room)

For consumer apps that want to display "configure your softphone" in a
settings screen before the user joins any specific room:

```
POST /internal/v1/users/sip-credentials
```

Request:
```json
{
  "appId": "myapp",
  "domainUserId": "<user-uuid>",
  "displayName": "Jane Doe"
}
```

Response:
```json
{
  "status": "available",
  "username": "comms_7f3c1b2e9a4d4b56",
  "password": "5f4dcc3b5aa765d61d8327deb882cf9904...",
  "registrar": "sip:comms-kamailio:5060;transport=udp",
  "domain": "comms.local",
  "transport": "udp"
}
```

Note: no `roomUri` in this response (there's no room in scope). The
client shows the registrar + credentials; the user can dial specific
room URIs later.

## 3. Dial a Room (client-side, not an API call)

Once the softphone is registered, the user dials:

```
sip:room-<contextId>@<domain>
```

Kamailio authenticates the INVITE via DIGEST, rewrites the destination
to the Janus SIP bridge, and forwards the call with an
`X-Comms-Context-Id` header. Janus's SIP plugin accepts the call and
bridges the audio into the matching AudioBridge room.

*(Note: the NestJS event handler that makes this last step work is
pending — see `01-architecture.md` under "What's Pending".)*

## Health Check

```
GET /health
```

Response:
```json
{
  "status": "ok",
  "matrix": "connected",
  "janus":  "connected",
  "sip":    "registered"
}
```

`sip` values:
- `"registered"`   — SipService loaded; Janus SIP bridge registered with Kamailio
- `"unregistered"` — SipService loaded but bridge not yet registered
- `"disabled"`     — SipModule not loaded (SIP_ENABLED=false)

## Error Codes

| Status | Meaning |
|---|---|
| 200 | Success |
| 422 | DTO validation failed (pipe in displayName, missing field, etc.) |
| 503 | SIP disabled (`SIP_ENABLED=false`) or SIP credential provisioning failed |
