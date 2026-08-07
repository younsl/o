#!/usr/bin/env node
// Sync root tsconfig.json `references` from packages/* and plugins/* that
// own a tsconfig.json. Default: write the file. With --check: exit 1 if
// references are out of sync (used by CI).

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const rootTsconfigPath = join(repoRoot, 'tsconfig.json');

const SCAN_DIRS = ['packages', 'plugins'];

function discoverRefs() {
  const refs = [];
  for (const top of SCAN_DIRS) {
    const topAbs = join(repoRoot, top);
    let entries;
    try {
      entries = readdirSync(topAbs);
    } catch {
      continue;
    }
    for (const name of entries.sort()) {
      const pkgDir = join(topAbs, name);
      const tsconfig = join(pkgDir, 'tsconfig.json');
      try {
        if (
          statSync(pkgDir).isDirectory() &&
          statSync(tsconfig).isFile()
        ) {
          refs.push({ path: `${top}/${name}` });
        }
      } catch {
        // missing or unreadable — skip
      }
    }
  }
  return refs;
}

function loadRoot() {
  const raw = readFileSync(rootTsconfigPath, 'utf8');
  return { raw, json: JSON.parse(raw) };
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.path === b[i].path);
}

function main() {
  const check = process.argv.includes('--check');

  // Skip silently when running in a partial workspace (e.g., Docker build
  // stage before the full source tree is copied). The CI guard runs in a
  // full checkout, so check-mode still works there.
  try {
    statSync(rootTsconfigPath);
  } catch {
    if (!check) return 0;
    console.error(
      `tsconfig.json not found at ${rootTsconfigPath}; cannot run in check mode.`,
    );
    return 1;
  }

  const desired = discoverRefs();
  if (desired.length === 0) {
    // No subpackage tsconfigs (only package.json copied) → not a full
    // workspace; nothing to sync.
    return 0;
  }

  const { json } = loadRoot();
  const current = json.references ?? [];

  if (arraysEqual(current, desired)) {
    if (!check) console.log('tsconfig.json references are up to date.');
    return 0;
  }

  if (check) {
    console.error('tsconfig.json `references` is out of sync.');
    console.error('Expected:');
    console.error(JSON.stringify(desired, null, 2));
    console.error('Actual:');
    console.error(JSON.stringify(current, null, 2));
    console.error('Run `yarn sync:tsconfig-refs` to fix.');
    return 1;
  }

  json.references = desired;
  writeFileSync(rootTsconfigPath, `${JSON.stringify(json, null, 2)}\n`);
  console.log(
    `tsconfig.json references updated: ${desired.length} entries.`,
  );
  return 0;
}

process.exit(main());
