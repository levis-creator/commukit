# 03 — Integration Guide (Step-by-Step with Examples)

How to wire a consumer app to SIP softphone access. Most of the work is
on the client side (showing users the credentials so they can configure
their softphone) — the backend just fetches credentials from comms.

Backend examples use **Express.js** (plain JavaScript, Node 18+). Every
shape translates directly to any HTTP framework (Fastify, Koa, Hono,
NestJS, Go/Python/Java).

---

## Prerequisites

- comms-service deployed with `SIP_ENABLED=true`
- `COMPOSE_PROFILES` includes both `media` and `sip`
- A working `INTERNAL_SERVICE_SECRET` shared with your backend

---

## Step 1 — Pick an `appId` and add config

```bash
# .env (consumer backend)
COMMS_APP_ID=myapp
COMMUNICATIONS_SERVICE_URL=http://comms-service:3014
INTERNAL_SERVICE_SECRET=<same-value-as-comms-service>
```

---

## Step 2 — Reuse the JWT signer from chat docs

The JWT signer is identical across every capability. Copy it from
[`../chat/03-integration.md`](../chat/03-integration.md#step-2--write-an-internal-jwt-signer):

```js
// src/communications/internalToken.js
const jwt = require('jsonwebtoken');

const SECRET = process.env.INTERNAL_SERVICE_SECRET;
const APP_ID = process.env.COMMS_APP_ID || 'myapp';

function signInternalToken() {
  return jwt.sign(
    { iss: APP_ID },
    SECRET,
    { audience: 'communications-service', expiresIn: '60s' },
  );
}

module.exports = { signInternalToken };
```

---

## Step 3 — Extend your comms HTTP client with a SIP call

If you already wired `provisionRoom`/`authorizeUser` from the chat or
audio integration guide, you only need one new method:

```js
// src/communications/commsClient.js
const { signInternalToken } = require('./internalToken');

const BASE_URL = (process.env.COMMUNICATIONS_SERVICE_URL || 'http://localhost:3014')
  .replace(/\/$/, '');
const APP_ID = process.env.COMMS_APP_ID || 'myapp';

async function post(path, body) {
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${signInternalToken()}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`[comms] POST ${path} → ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[comms] POST ${path} failed:`, err.message);
    return null;
  }
}

// Standalone SIP credential fetch — use this for settings screens
// and any pre-room flow that just wants to hand the user their
// softphone credentials.
async function getSipCredentials({ domainUserId, displayName }) {
  return post('/internal/v1/users/sip-credentials', {
    appId: APP_ID,
    domainUserId,
    displayName,
  });
}

module.exports = { getSipCredentials /* + your existing methods */ };
```

The response shape:

```js
// {
//   status:    'available' | 'unavailable',
//   reason?:   string,           // present when status is 'unavailable'
//   username?: string,           // e.g. 'comms_7f3c1b2e9a4d4b56'
//   password?: string,           // DIGEST credential — treat as a secret
//   registrar?:string,           // full registrar URI
//   domain?:   string,           // SIP domain, e.g. 'comms.local'
//   transport?:'udp'|'tcp'|'tls',
// }
```

---

## Step 4 — Expose a settings endpoint to your client

```js
// src/routes/settings.routes.js
const express = require('express');
const { getSipCredentials } = require('../communications/commsClient');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/me/softphone-credentials', requireAuth, async (req, res, next) => {
  try {
    const creds = await getSipCredentials({
      domainUserId: req.user.id,
      displayName: req.user.displayName,
    });

    if (!creds || creds.status !== 'available') {
      return res.status(503).json({
        error: 'Softphone access unavailable',
        reason: creds?.reason ?? 'SIP disabled',
      });
    }

    // Strip secrets from logs — the response includes a password.
    // Never log this whole object.
    res.json({
      username: creds.username,
      password: creds.password,
      domain: creds.domain,
      registrar: creds.registrar,
      transport: creds.transport,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
```

---

## Step 5 — Show the credentials in your app UI

The client displays the four fields (username, password, domain,
transport) in a settings screen and provides a "Copy" button for each.
Link to [`04-softphone-setup.md`](04-softphone-setup.md) for per-client
setup instructions.

Example React snippet:

```jsx
function SoftphoneSettings() {
  const [creds, setCreds] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/me/softphone-credentials', { credentials: 'include' })
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e)))
      .then(setCreds)
      .catch(setError);
  }, []);

  if (error) return <div>Softphone access unavailable: {error.reason}</div>;
  if (!creds) return <div>Loading…</div>;

  return (
    <div>
      <h2>Configure your softphone</h2>
      <p>Install a free SIP softphone (Linphone, Zoiper, MicroSIP, Jitsi)
        and enter these credentials:</p>
      <Field label="Username" value={creds.username} />
      <Field label="Password" value={creds.password} sensitive />
      <Field label="Domain"   value={creds.domain} />
      <Field label="Transport" value={creds.transport.toUpperCase()} />
      <a href="/help/softphone-setup">How do I set this up?</a>
    </div>
  );
}
```

---

## Step 6 — In-room flow (authorize-user also returns SIP)

If you're already calling `authorize-user` to get chat/audio/video
credentials for a specific room, you don't need a separate call for
SIP — the response now includes a `sip` field for any room with an
AudioBridge:

```js
// Your existing authorize-user call
const session = await authorizeUser(contextId, {
  contextType: 'MEETING',
  domainUserId: req.user.id,
  displayName: req.user.displayName,
});

// session.sip is either:
//   null                                          (room has no AudioBridge)
//   { status: 'unavailable', reason: '...' }      (SIP disabled / provisioning failed)
//   { status: 'available', username, password, registrar, domain, transport,
//     roomUri: 'sip:room-<contextId>@<domain>' }
```

The in-room response additionally includes a `roomUri` field — this is
the SIP address the user dials from their softphone to join the specific
room. Display it next to the credentials:

> Dial `sip:room-4f8a2b31@comms.local` from your registered softphone
> to join this meeting.

---

## Step 7 — Subscribe to lifecycle events (optional)

Comms publishes `communications.room.provisioned/activated/closed` on
RabbitMQ. Nothing SIP-specific — the same events cover every capability.
If you want to drive a UI that says "X joined the call via phone" you
can subscribe to the existing audit log rows or build a tap on the
fanout exchange. See
[`../audio/03-integration.md#step-9`](../audio/03-integration.md) for
the RabbitMQ consumer pattern.

---

## End-to-End Sequence (Settings Screen)

```
User opens settings          ──▶ GET /me/softphone-credentials
Your backend                 ──▶ POST /internal/v1/users/sip-credentials
comms-service                ──▶ SipService.ensureUserCredentials()
                                 └─▶ INSERT subscriber into Kamailio DB
                                 └─▶ UPDATE communication_users
comms-service                ──▶ returns { username, password, domain, ... }
Your backend                 ──▶ returns same shape to client
Client                       ──▶ displays credentials + setup instructions
User                         ──▶ pastes creds into Linphone/Zoiper/...
Softphone                    ──▶ REGISTER with Kamailio (DIGEST auth)
Kamailio                     ──▶ authenticates against subscriber.ha1
Softphone now shows "Registered" ✅
```
