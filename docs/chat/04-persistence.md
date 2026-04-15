# 04 — Storing Chat Data Yourself

By default **messages live only in Synapse**. That is usually fine — Synapse
is a reliable store and the client can paginate history via CS-API. But if
your app has compliance, analytics, or cross-database-join requirements, you
may want a local copy.

## Option A — Pull from Matrix on demand (simplest)

Don't persist at all. Let clients call
`GET /_matrix/client/v3/rooms/:id/messages` against Synapse directly. Works
when the retention window you need matches Synapse's own.

**Trade-off:** no extra infrastructure, but no search/analytics and you're
locked to Synapse's retention policy.

## Option B — Snapshot on close (archival)

When you call `closeRoom`, immediately before or after, run a worker that:

1. Uses the bot token (or a fresh admin token) to paginate the full room via
   `/messages?dir=b` from the latest event backward until exhausted.
2. Writes events to a table in your consumer DB (schema below).
   Deduplicate by `event_id`.
3. Marks the room "archived" in your own state.

**Trade-off:** one-time cost per room, minimal runtime overhead. You can't
query mid-session.

## Option C — Live mirroring (real-time archive)

Run a background service that acts as a Matrix user (use the bot or a
dedicated archiver account) and keeps a `/sync` stream open per active room.
On every `m.room.message` event, insert into your own table.

**Trade-off:** highest fidelity, enables search/analytics/joins, but requires
a long-running consumer with careful reconnection and dedup logic.

## Option D — Hook into the event bus

Add a new RabbitMQ event, e.g. `communications.message.persisted`, published
by a lightweight archiver. Other services can subscribe without touching
Matrix directly.

## Recommended Schema

```sql
CREATE TABLE chat_messages (
  id              BIGSERIAL PRIMARY KEY,
  app_id          TEXT NOT NULL,
  context_type    TEXT NOT NULL,
  context_id      TEXT NOT NULL,
  matrix_room_id  TEXT NOT NULL,
  matrix_event_id TEXT NOT NULL UNIQUE,
  sender_matrix   TEXT NOT NULL,
  sender_domain   TEXT,              -- resolved via comms CommunicationUser
  msg_type        TEXT NOT NULL,     -- m.text, m.image, m.file, ...
  body            TEXT,
  content_json    JSONB NOT NULL,    -- full event content for fidelity
  origin_ts       TIMESTAMPTZ NOT NULL,
  inserted_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON chat_messages (app_id, context_type, context_id, origin_ts);
CREATE INDEX ON chat_messages (sender_domain, origin_ts);
```

## Resolving Matrix → Domain Identity

The Matrix user ID is `@comms_<16chars>:<server>`. To get back the original
`domainUserId`, join against `communication_users.matrix_user_id` in the
comms DB — or expose a resolver endpoint on comms-service if you don't want
direct DB access.

## Attachments (images, files)

Matrix stores uploaded media in its own media repo (mxc:// URIs). If you
need durable copies:

1. When archiving an event of type `m.image` / `m.file`, resolve the
   `mxc://` URI to an HTTPS download via `/_matrix/media/v3/download/...`
   using the bot token.
2. Re-upload the blob to your own object store (S3, Azure Blob, etc.).
3. Record the object-store key next to the event row.

## Retention and Deletion

- Synapse has its own retention policies — configure them in
  `homeserver.yaml` if you want automatic pruning.
- For GDPR-style erasure you must delete from both your archive table **and**
  Synapse (admin API: `DELETE /_synapse/admin/v1/rooms/...` or per-event
  redaction).
- Audit every deletion in `communication_audit_logs` or your own trail.
