// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2025 Levis Nyingi and commukit contributors
import { Global, Module } from '@nestjs/common';
import { MatrixService } from './matrix.service';
import { CHAT_PROVIDER } from '../providers/tokens';

/**
 * Binds `MatrixService` as the `CHAT_PROVIDER` for the Nest DI container.
 *
 * The concrete `MatrixService` is still exported for tests and for any
 * Matrix-specific code paths that may emerge; new code should prefer
 * `@Inject(CHAT_PROVIDER)` over a direct class import.
 */
@Global()
@Module({
  providers: [
    MatrixService,
    { provide: CHAT_PROVIDER, useExisting: MatrixService },
  ],
  exports: [MatrixService, CHAT_PROVIDER],
})
export class MatrixModule {}
