-- ─────────────────────────────────────────────────────────────────────────────
-- Kamailio subscriber + location schema
-- ─────────────────────────────────────────────────────────────────────────────
-- Minimal subset of Kamailio's standard Postgres schema, lifted from the
-- upstream `kamailio-postgres.sql` distribution. Only the tables the
-- communications-service actually uses are included here:
--
--   subscriber  — SIP DIGEST credentials written by comms-service
--   location    — REGISTER contact bindings (managed by Kamailio itself)
--   version     — schema version table referenced by auth_db / usrloc
--
-- This script runs on first boot of the comms-postgres container via the
-- image's docker-entrypoint-initdb.d hook. It is idempotent (CREATE IF NOT
-- EXISTS) and safe to re-run even on existing databases.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS version (
    table_name  VARCHAR(64) NOT NULL PRIMARY KEY,
    table_version INTEGER NOT NULL DEFAULT 0
);

-- Subscriber table — holds SIP DIGEST credentials for each user.
-- Populated exclusively by comms-service's SipService.ensureUserCredentials().
CREATE TABLE IF NOT EXISTS subscriber (
    id          BIGSERIAL PRIMARY KEY,
    username    VARCHAR(64) NOT NULL DEFAULT '',
    domain      VARCHAR(64) NOT NULL DEFAULT '',
    password    VARCHAR(64) NOT NULL DEFAULT '',
    email_address VARCHAR(64) NOT NULL DEFAULT '',
    ha1         VARCHAR(64) NOT NULL DEFAULT '',
    ha1b        VARCHAR(64) NOT NULL DEFAULT '',
    rpid        VARCHAR(64) DEFAULT NULL,
    CONSTRAINT subscriber_account_idx UNIQUE (username, domain)
);

CREATE INDEX IF NOT EXISTS subscriber_username_idx ON subscriber (username);

INSERT INTO version (table_name, table_version)
    VALUES ('subscriber', 7)
    ON CONFLICT (table_name) DO UPDATE SET table_version = EXCLUDED.table_version;

-- Location table — REGISTER contact bindings. Managed by Kamailio's usrloc
-- module directly; comms-service never writes to it. Included here so the
-- module has its schema ready on first boot.
CREATE TABLE IF NOT EXISTS location (
    id           BIGSERIAL PRIMARY KEY,
    ruid         VARCHAR(64) NOT NULL DEFAULT '',
    username     VARCHAR(64) NOT NULL DEFAULT '',
    domain       VARCHAR(64) DEFAULT NULL,
    contact      VARCHAR(512) NOT NULL DEFAULT '',
    received     VARCHAR(128) DEFAULT NULL,
    path         VARCHAR(512) DEFAULT NULL,
    expires      TIMESTAMP NOT NULL DEFAULT '2030-05-28 21:32:15',
    q            REAL NOT NULL DEFAULT 1.0,
    callid       VARCHAR(255) NOT NULL DEFAULT 'Default-Call-ID',
    cseq         INTEGER NOT NULL DEFAULT 1,
    last_modified TIMESTAMP NOT NULL DEFAULT '1900-01-01 00:00:01',
    flags        INTEGER NOT NULL DEFAULT 0,
    cflags       INTEGER NOT NULL DEFAULT 0,
    user_agent   VARCHAR(255) NOT NULL DEFAULT '',
    socket       VARCHAR(64) DEFAULT NULL,
    methods      INTEGER DEFAULT NULL,
    instance     VARCHAR(255) DEFAULT NULL,
    reg_id       INTEGER NOT NULL DEFAULT 0,
    server_id    INTEGER NOT NULL DEFAULT 0,
    connection_id INTEGER NOT NULL DEFAULT 0,
    keepalive    INTEGER NOT NULL DEFAULT 0,
    partition    INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT location_ruid_idx UNIQUE (ruid)
);

CREATE INDEX IF NOT EXISTS location_account_contact_idx ON location (username, domain, contact);
CREATE INDEX IF NOT EXISTS location_expires_idx ON location (expires);

INSERT INTO version (table_name, table_version)
    VALUES ('location', 9)
    ON CONFLICT (table_name) DO UPDATE SET table_version = EXCLUDED.table_version;
