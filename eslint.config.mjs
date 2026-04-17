// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2025 Levis Nyingi and commukit contributors

// ESLint flat config (ESLint v9+). Permissive baseline suitable for a
// NestJS + Prisma codebase; we lean on TypeScript for correctness and
// Prettier for formatting, so ESLint focuses on obvious bugs.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'prisma/migrations/**',
      '*.config.mjs',
      'scripts/**/*.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Relaxed to `warn` during ESLint onboarding so Phase 4 doesn't
      // require refactors under src/. Tighten to `error` in a dedicated
      // follow-up once existing call sites are cleaned up.
      'no-useless-catch': 'warn',
    },
  },
];
