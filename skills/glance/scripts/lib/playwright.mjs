// Locate Playwright without bundling it. Order:
//   1. GLANCE_PLAYWRIGHT: a module specifier or a path to playwright's index.mjs / package folder
//   2. `playwright`, then `playwright-core`, resolved from this file (a local node_modules)
//   3. the global npm prefix (`npm root -g`), so `npm i -g playwright` works too
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

function entryOf(dir) {
  for (const f of ['index.mjs', 'index.js']) { const p = path.join(dir, f); if (fs.existsSync(p)) return p; }
  return null;
}

function globalRoot() {
  try {
    // npm is a .cmd shim on Windows, which needs a shell; the command is a constant string.
    return execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 15000 }).trim();
  } catch { return null; }
}

export async function loadPlaywright(hint) {
  const tried = [];
  const attempt = async spec => {
    tried.push(spec);
    try {
      const mod = await import(spec);
      const chromium = mod.chromium || mod.default?.chromium;
      if (chromium) return chromium;
    } catch { /* try the next one */ }
    return null;
  };
  if (hint) {
    const p = path.resolve(hint);
    const file = fs.existsSync(p) ? (fs.statSync(p).isDirectory() ? entryOf(p) : p) : null;
    const c = await attempt(file ? pathToFileURL(file).href : hint);
    if (c) return c;
  }
  for (const name of ['playwright', 'playwright-core']) {
    let resolved = null;
    try { resolved = require.resolve(name); } catch { /* not local */ }
    if (resolved) { const c = await attempt(pathToFileURL(resolved).href); if (c) return c; }
  }
  const root = globalRoot();
  if (root) {
    for (const name of ['playwright', 'playwright-core']) {
      const e = entryOf(path.join(root, name));
      if (e) { const c = await attempt(pathToFileURL(e).href); if (c) return c; }
    }
  }
  const err = new Error('Playwright not found. Install it with:\n  npm install -g playwright && playwright install chromium\n' +
    'or point GLANCE_PLAYWRIGHT at an existing installation. Tried: ' + tried.join(', '));
  err.code = 'GLANCE_NO_PLAYWRIGHT';
  throw err;
}
