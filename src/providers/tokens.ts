// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2025 Levis Nyingi and commukit contributors
/**
 * Nest DI injection tokens for pluggable communications providers.
 *
 * Consumers inject these tokens instead of the concrete `JanusService` /
 * `MatrixService` classes so alternative implementations (LiveKit, etc.)
 * can be swapped in via `app.module.ts` without touching call sites.
 */
export const MEDIA_PROVIDER = Symbol('MEDIA_PROVIDER');
export const CHAT_PROVIDER = Symbol('CHAT_PROVIDER');
export const SIP_PROVIDER = Symbol('SIP_PROVIDER');
