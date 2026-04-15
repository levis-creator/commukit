# 07 — Media Uploads in Chat

This document describes how to send images, files, and other media through
the chat channel. The approach uses an **object-storage bucket** (S3-compatible
or Azure Blob) as the file store; the resulting public URL is embedded into a
standard Matrix `m.image` / `m.file` / `m.video` event so every chat client
that understands Matrix media events can render it natively.

---

## Why Not Matrix's Built-in Media Store?

Matrix Synapse ships its own media repository (`/_matrix/media/…`) and it
works fine for small deployments. For production the bucket approach is
preferable because:

- **Scale** — Synapse's local media store grows on disk with no CDN or
  lifecycle policies. A bucket gives you CDN, versioning, and lifecycle rules.
- **Access control** — bucket presigned URLs or public object ACLs give you
  fine-grained, time-limited access without touching Synapse.
- **Portability** — if you migrate away from Synapse, all your media URLs
  remain stable.
- **Searchability** — object metadata and tags are indexable; Synapse's media
  store is opaque.

---

## Architecture

```
Client app
    │
    │  1. POST /upload-media   (consumer backend endpoint, your auth)
    │     multipart/form-data
    │
    ▼
Consumer backend  (StorageService)
    │
    │  2. upload(buffer, filename, mimeType)
    │
    ▼
Object-storage bucket  (S3 / MinIO / Azure Blob)
    │
    │  3. returns { url, key, filename, mimeType, size }
    │
    ▼
Consumer backend  ──── response ────▶  Client app
                                            │
                                            │  4. PUT /_matrix/client/v3/rooms/:roomId/
                                            │       send/m.room.message/:txn
                                            │     { msgtype: "m.image", body: "photo.jpg",
                                            │       url: "<bucket-url>",
                                            │       info: { mimetype, size, w?, h? } }
                                            ▼
                                       Matrix Synapse
                                            │
                                            │  5. sync event delivered to all room members
                                            ▼
                                       Other clients  →  Image.network(url) / download link
```

**Key design choices:**

- The client uploads through the **consumer backend**, not directly to the
  bucket, so auth and file-type/size policies are enforced centrally.
- The consumer backend owns `StorageService`, which wraps S3/Azure/disk behind
  a single interface. Provider is selected at boot via `STORAGE_PROVIDER`.
- The returned bucket URL is **plain HTTPS** — no `mxc://` scheme. Every
  client can render it with `Image.network()` or `<img>` without any
  mxc-to-http conversion proxy.
- The Matrix event is sent by the client directly against Synapse CS-API using
  the scoped access token from `/authorize-user`. The consumer backend is not
  involved in the Matrix send step.

---

## Storage Provider Configuration

Set `STORAGE_PROVIDER` in your consumer backend's `.env` to choose the
backend. The remaining variables depend on which provider you select.

### S3 / MinIO / DigitalOcean Spaces / Cloudflare R2

```env
STORAGE_PROVIDER=s3
STORAGE_S3_BUCKET=app-chat-media
STORAGE_S3_REGION=us-east-1
STORAGE_S3_ACCESS_KEY_ID=<your-key>
STORAGE_S3_SECRET_ACCESS_KEY=<your-secret>

# Leave empty for AWS. Set to MinIO / Spaces / R2 endpoint for self-hosted:
STORAGE_S3_ENDPOINT=http://localhost:9000

# Required for MinIO (path-style URLs); false for AWS / Spaces / R2
STORAGE_S3_FORCE_PATH_STYLE=false

# Optional CDN prefix. If set, URLs become <CDN>/<key> instead of the
# default bucket hostname. Example: https://cdn.example.com
STORAGE_S3_PUBLIC_URL=
```

**MinIO quick-start** (local dev, Docker):
```bash
docker run -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=admin \
  -e MINIO_ROOT_PASSWORD=password \
  quay.io/minio/minio server /data --console-address ":9001"
```

```env
STORAGE_PROVIDER=s3
STORAGE_S3_BUCKET=app-chat-media
STORAGE_S3_REGION=us-east-1
STORAGE_S3_ACCESS_KEY_ID=admin
STORAGE_S3_SECRET_ACCESS_KEY=password
STORAGE_S3_ENDPOINT=http://localhost:9000
STORAGE_S3_FORCE_PATH_STYLE=true
```

### Azure Blob Storage

```env
STORAGE_PROVIDER=azure
STORAGE_AZURE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...
STORAGE_AZURE_CONTAINER=app-chat-media

# Optional CDN prefix
STORAGE_AZURE_PUBLIC_URL=
```

The container is created automatically with public-blob access if it does not
exist. To use private blobs + SAS tokens, see
[Extending with Presigned URLs](#extending-with-presigned-urls) below.

### Disk (development default)

```env
STORAGE_PROVIDER=disk            # default when STORAGE_PROVIDER is not set
STORAGE_DISK_PATH=./uploads
STORAGE_DISK_SERVE_URL=http://localhost:3000/uploads
```

Files are saved to `./uploads/<folder>/<timestamp>-<random>.<ext>` and served
by a static-files middleware. **Do not use in production.**

---

## Upload API

The consumer backend exposes one endpoint for file uploads. The exact path is
up to the consumer — implement it wherever fits your domain model. Below is
the recommended contract.

**Request** — `multipart/form-data`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `file` | binary | yes | The file to upload |

**Limits** (recommended defaults — consumer configures these)

| Parameter | Default | Env var |
|-----------|---------|---------|
| Max file size | 20 MB | `UPLOAD_MAX_SIZE_MB` |
| Allowed MIME types | `image/*`, `application/pdf`, `video/mp4`, `video/webm`, `audio/mpeg`, `audio/ogg` | — |

**Response `200`**

```json
{
  "url": "https://cdn.example.com/chat-media/1748000000000-a1b2c3d4.jpg",
  "filename": "photo.jpg",
  "mimeType": "image/jpeg",
  "size": 143210
}
```

**Error responses**

| Status | Reason |
|--------|--------|
| 400 | Missing file, file too large, or disallowed MIME type |
| 401 | Missing or invalid auth token |
| 403 | Caller lacks permission for this context |
| 404 | Context not found |
| 503 | Storage backend unreachable |

---

## Sending the Matrix Event (Client)

After a successful upload, the client sends a Matrix `m.room.message` event.
The `msgtype` is derived from the MIME type:

```
image/*   →  m.image
video/*   →  m.video
*         →  m.file
```

**Event payload**

```json
{
  "msgtype": "m.image",
  "body": "photo.jpg",
  "url": "https://cdn.example.com/chat-media/1748000000000-a1b2c3d4.jpg",
  "info": {
    "mimetype": "image/jpeg",
    "size": 143210,
    "w": 1920,
    "h": 1080
  }
}
```

For `m.file` and `m.video`, omit `w`/`h` (not applicable). `body` is always
the human-readable filename — clients use it as the fallback label.

Send it via:

```
PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txnId}
Authorization: Bearer <user-scoped-access-token>
```

The access token comes from the `/authorize-user` session response —
see [02-api-flow.md](02-api-flow.md).

---

## Receiving and Rendering (Client)

When a sync event arrives with `type: m.room.message`, inspect `content.msgtype`:

| `msgtype` | Render as |
|-----------|-----------|
| `m.text` | Text bubble (existing behaviour) |
| `m.image` | Inline image (`Image.network(content.url)`) with tap-to-expand |
| `m.video` | Thumbnail placeholder + play icon; tap opens `content.url` |
| `m.file` | File icon + `content.body` (filename) + size badge; tap downloads |

`content.url` is a plain HTTPS URL — no mxc-to-http translation needed.

**Extend your message model** to carry the media fields alongside the existing
text fields:

```
msgtype    string   // 'm.text' | 'm.image' | 'm.file' | 'm.video'
mediaUrl   string?  // null for m.text
filename   string?  // content.body for media types
mimeType   string?  // content.info.mimetype
mediaSize  int?     // content.info.size in bytes
```

---

## Sequence Diagram

```
Client app      Consumer backend     Storage bucket      Matrix Synapse
    │                  │                   │                    │
    │── pick file ────▶│                   │                    │
    │   POST /upload   │                   │                    │
    │                  │── upload ────────▶│                    │
    │                  │◀─ { url, … } ─────│                    │
    │◀─ { url, … } ────│                   │                    │
    │                  │                   │                    │
    │── PUT m.room.message (m.image, url) ──────────────────────▶│
    │◀─ { event_id } ───────────────────────────────────────────│
    │                  │                   │                    │
    │  (other clients receive via /sync)                        │
    │◀──────────────────────────────────── sync event ──────────│
    │  render Image.network(url)                                │
```

---

## Security Notes

- Uploaded files served from a **public bucket URL** require no auth to
  download. Do not use this flow for sensitive or classified content — use a
  dedicated secure-document endpoint with access-controlled presigned URLs for
  those (see [Extending with Presigned URLs](#extending-with-presigned-urls)).
- Object keys include a random 8-byte hex component to prevent URL enumeration.
- For Azure, the container is created with `access: 'blob'` (individual blobs
  public, container listing private).
- For S3, scope the public-read bucket policy to the `chat-media/*` prefix
  only. Do not enable "Block all public access" at the account level — use a
  bucket policy instead.
- Validate MIME type server-side from the parsed multipart content, not from
  the client-supplied `Content-Type` header, to prevent spoofing.

---

## One-on-One (Direct Message) File Sharing

The upload mechanics are **identical** for 1:1 chats. What differs is how the
Matrix room is provisioned and kept alive, because DM rooms have no external
lifecycle event to drive `activate` / `close`.

### Room Provisioning for DMs

A DM room needs a **stable, deterministic contextId** that is the same
regardless of which user initiates the conversation. The recommended approach
is to sort the two user IDs lexicographically and hash them:

```js
// Consumer backend helper — Node.js
const { createHash } = require('crypto');

function dmContextId(userIdA, userIdB) {
  const [a, b] = [userIdA, userIdB].sort();
  return createHash('sha256')
    .update(`dm:${a}:${b}`)
    .digest('hex')
    .slice(0, 32);        // 32-char hex — safe as a UUID substitute
}
```

Provision the room once, lazily, when the first message or upload is attempted:

```js
async function ensureDmRoom(userIdA, userIdB) {
  const contextId  = dmContextId(userIdA, userIdB);
  const contextType = 'DM';

  // Idempotent — returns existing room if already provisioned
  const room = await provisionRoom({
    contextType,
    contextId,
    title: `dm:${contextId}`,   // opaque; only comms sees it
    mode: 'CHAT',               // chat-only, no Janus audio/video
  });

  // DM rooms are immediately active — no separate activate call needed
  // (or call activateRoom once after provision if your comms version requires it)
  await activateRoom(contextId, contextType);

  return { contextId, contextType };
}
```

Use `mode: 'CHAT'` — this tells comms not to create Janus rooms, keeping the
overhead minimal.

### Authorize Both Participants

Each participant calls `authorizeUser` independently (typically when they open
the DM thread). Both get a Matrix access token scoped to the same room:

```js
router.get('/dms/:otherUserId/session', requireAuth, async (req, res, next) => {
  const { contextId, contextType } = await ensureDmRoom(
    req.user.id,
    req.params.otherUserId,
  );

  const session = await authorizeUser(contextId, {
    contextType,
    domainUserId: req.user.id,
    displayName: req.user.displayName,
    roles: ['PARTICIPANT'],
  });

  res.json(session);
});
```

### Uploading and Sending in a DM

Unchanged from the group case — the upload endpoint doesn't know or care
whether the room is a DM or a group:

```
Client A picks file
  → POST /upload-media
  ← { url, filename, mimeType, size }
  → PUT /_matrix/.../rooms/{dmRoomId}/send/m.room.message/{txn}
      { msgtype: "m.image", body: "photo.jpg", url: "..." }
  → Matrix delivers to Client B via /sync
```

### DM Lifecycle Differences vs Group Rooms

| Aspect | Group room | DM room |
|--------|-----------|---------|
| `contextId` | Domain entity ID (UUID) | Deterministic hash of both user IDs |
| `mode` | `IN_PERSON` / `HYBRID` / `REMOTE` | `CHAT` |
| Activate | On domain event (meeting starts) | Immediately after provision |
| Close | On domain event (meeting ends) | Never, or on explicit user action |
| Re-provision | Returns existing room (idempotent) | Same — hash is stable |

### Closing a DM (Optional)

If your product allows users to "delete" a DM thread, call `closeRoom`. Comms
logs both participants out and prevents re-authorization. To reopen the thread
later you must provision a new room — once closed, rooms are not reopened.

If you don't need this, simply never call `closeRoom` for DMs and the room
stays open indefinitely.

---

## Extending with Presigned URLs

For private-by-default storage, return a **presigned download URL** with a TTL
instead of a permanent public URL:

1. `StorageService.upload()` generates a short-lived presigned URL after
   storing the object (S3: `GetObjectCommand` + `getSignedUrl`; Azure:
   `generateSasUrl`).
2. The client embeds the presigned URL into the Matrix event.
3. On render, the client checks if the URL has expired and requests a refresh
   via a consumer backend endpoint (e.g.
   `GET /media/refresh?key=<object-key>`), which calls
   `StorageService.presign(key, ttl)`.

The `StorageService` interface is designed to accommodate this variant without
breaking existing callers — presigned URLs are opt-in per consumer.
