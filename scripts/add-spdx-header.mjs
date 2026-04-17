#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2025 Levis Nyingi and commukit contributors

// Walks src/**/*.ts and ensures every file begins with the SPDX header
// defined in COPYING.HEADER at the repo root.
//
// Modes:
//   node scripts/add-spdx-header.mjs            apply headers (default)
//   node scripts/add-spdx-header.mjs --check    report only; exit 1 if any file would change
//
// Idempotent: a file whose first non-empty line already contains
// "SPDX-License-Identifier" is skipped. Re-running with --check after
// a successful apply must exit 0 with zero pending files.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(repoRoot, 'src');
const headerFile = join(repoRoot, 'COPYING.HEADER');
const SPDX_MARKER = 'SPDX-License-Identifier';

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');

async function walkTsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkTsFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

function needsHeader(content) {
  // A file "has" the header if the first non-empty line contains the SPDX marker.
  // We only check the first line of actual content (skipping a leading shebang,
  // if ever present) so we catch drift early.
  const lines = content.split('\n');
  let i = 0;
  if (lines[i]?.startsWith('#!')) i++;
  while (i < lines.length && lines[i].trim() === '') i++;
  return !(lines[i]?.includes(SPDX_MARKER));
}

function applyHeader(content, header) {
  const lines = content.split('\n');
  if (lines[0]?.startsWith('#!')) {
    const shebang = lines.shift();
    const rest = lines.join('\n');
    return `${shebang}\n${header}\n${rest}`;
  }
  return `${header}\n${content}`;
}

async function main() {
  const header = (await readFile(headerFile, 'utf8')).replace(/\s+$/, '');
  const files = await walkTsFiles(srcRoot);

  let modified = 0;
  let skipped = 0;
  const pending = [];

  for (const file of files) {
    const content = await readFile(file, 'utf8');
    if (!needsHeader(content)) {
      skipped++;
      continue;
    }
    pending.push(file);
    if (!checkOnly) {
      await writeFile(file, applyHeader(content, header), 'utf8');
      modified++;
    }
  }

  const rel = (p) => relative(repoRoot, p);

  if (checkOnly) {
    if (pending.length > 0) {
      console.error(`SPDX header missing from ${pending.length} file(s):`);
      for (const f of pending) console.error(`  ${rel(f)}`);
      console.error('Run: node scripts/add-spdx-header.mjs');
      process.exit(1);
    }
    console.log(`SPDX check OK (${skipped} file(s) already headed).`);
    return;
  }

  console.log(`SPDX apply: ${modified} modified, ${skipped} skipped, ${files.length} scanned.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
