#!/usr/bin/env node
/* Fails when the code sends an analytics event the contract does not list.
   The contract is docs/analytics-events.md: every event name in a backticked
   first column of its Events tables. The code is every capture('name', …) or
   track('name', …) under assets/js and modules. Run by CI on every PR; run it yourself with
   `node scripts/check-analytics-events.mjs`. */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const doc = readFileSync(join(root, 'docs/analytics-events.md'), 'utf8');

// Table rows whose first cell is one or more backticked names: | `a`, `b` | ...
const documented = new Set();
for (const line of doc.split('\n')) {
  const m = line.match(/^\|\s*((?:`[^`]+`\s*,?\s*)+)\|/);
  if (!m) continue;
  for (const name of m[1].match(/`([^`]+)`/g)) documented.add(name.slice(1, -1));
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(m?js)$/.test(name) && !/\.bak$/.test(name)) out.push(p);
  }
  return out;
}

const used = new Map();   // name -> [file:line]
for (const file of [...walk(join(root, 'assets/js')), ...walk(join(root, 'modules'))]) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/\b(?:capture|track)\(\s*['"]([^'"]+)['"]/g)) {
      const at = `${relative(root, file)}:${i + 1}`;
      used.set(m[1], [...(used.get(m[1]) || []), at]);
    }
  });
}

const missing = [...used].filter(([name]) => !documented.has(name));
if (missing.length) {
  console.error('Events sent by the code but not in docs/analytics-events.md:');
  for (const [name, where] of missing) console.error(`  ${name}  (${where.join(', ')})`);
  console.error('\nAdd them to the contract first, or rename them to match.');
  process.exit(1);
}
console.log(`OK: ${used.size} event name(s) in code, all in the contract (${documented.size} documented).`);
