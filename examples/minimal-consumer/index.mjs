// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2025 Levis Nyingi and commukit contributors

// Minimal consumer: provision a room, authorize a user, print the session.
//
// 1. Mints an internal JWT (aud: "communications-service").
// 2. POSTs /internal/v1/rooms/provision.
// 3. POSTs /internal/v1/rooms/:contextId/authorize-user.
// 4. Prints the unified session response.
//
// Run against a local `docker compose up` stack of commukit. Set
// INTERNAL_SERVICE_SECRET to the same value the service uses.

import jwt from 'jsonwebtoken';

const BASE_URL = process.env.COMMS_URL ?? 'http://localhost:3014';
const SECRET = process.env.INTERNAL_SERVICE_SECRET;
const API_VERSION = process.env.COMMS_API_VERSION ?? '2';

if (!SECRET) {
  console.error('Set INTERNAL_SERVICE_SECRET (match the comms-service .env).');
  process.exit(1);
}

const APP_ID = 'demo-app';
const CONTEXT_TYPE = 'meeting';
const CONTEXT_ID = `demo-${Date.now()}`;

function mintToken() {
  return jwt.sign({ iss: 'demo-consumer' }, SECRET, {
    audience: 'communications-service',
    expiresIn: '5m',
  });
}

async function call(path, body, extraHeaders = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${mintToken()}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST ${path} -> ${res.status}: ${text}`);
  }
  return JSON.parse(text);
}

async function main() {
  console.log(`Provisioning room ${CONTEXT_ID}…`);
  const room = await call('/internal/v1/rooms/provision', {
    appId: APP_ID,
    contextType: CONTEXT_TYPE,
    contextId: CONTEXT_ID,
    title: 'Minimal Consumer Demo',
    mode: 'HYBRID',
  });
  console.log('  room:', room.status ?? 'PROVISIONED');

  console.log('Authorizing demo user…');
  const session = await call(
    `/internal/v1/rooms/${CONTEXT_ID}/authorize-user`,
    {
      appId: APP_ID,
      contextType: CONTEXT_TYPE,
      domainUserId: 'user-demo',
      displayName: 'Demo User',
      roles: ['MODERATOR'],
    },
    { 'X-Comms-API-Version': API_VERSION },
  );

  console.log('\nSession response:');
  console.log(JSON.stringify(session, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
