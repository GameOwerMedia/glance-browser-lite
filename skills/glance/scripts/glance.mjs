#!/usr/bin/env node
// glance client. Starts the shared server on first use, queues one job, prints the JSON result.
//
//   node glance.mjs shot <url> [--t 2] [--out page.png] [--width 960] [--height 540]
//   node glance.mjs shots <url> --ts 0.5,1,2 [--out page.png]      -> page-t0.5.png, page-t1.png, ...
//   node glance.mjs measure <url> [--duration-ms 3000] [--fn name]
//   node glance.mjs download <url> --out-dir exports [--click "#export"] [--expect 1]
//   node glance.mjs status | stop | help | version
//
// Every option is documented in references/cli.md; `help` prints the short form.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VERSION, loadConfig, parseArgs, stateFile, logFile, localToUrl } from './lib/core.mjs';

const HELP = `glance ${VERSION}: one shared hidden browser for every agent, with a job queue.

Usage:
  glance shot <url>      [--out file.png] [--t sec] [--width 960] [--height 540]
  glance shots <url>     --ts 1,2,5 [--out file.png]
  glance measure <url>   [--duration-ms 3000] [--fn windowFunction] [--fn-runs 10]
  glance download <url>  --out-dir DIR [--expect 1] [--prefix p-] [--shot file.png]
  glance status | stop | help | version

Page options (all jobs):
  --t sec            added to the URL as ?t=sec or &t=sec (before any #hash); --t-param renames it
  --wait-ms 1500     wait after the load event
  --wait-until load  load | domcontentloaded | networkidle | commit
  --cookie n=v       one cookie for the page origin (local test accounts only)
  --full-page        capture the whole page; --omit-background for a transparent PNG
Interaction (shot, shots, download), run in this order:
  --wait-js "expr"   wait until a page expression is truthy (--wait-js-ms 60000)
  --fill "sel=v|sel2=v"   --select "sel=v|..."   --check "sel,sel2"
  --click "sel,sel2"      --dom-click "sel,sel2" (element.click() inside the page)
  --after-ms 600     wait after the steps

Environment: GLANCE_PORT (default 7333), GLANCE_HOME, GLANCE_IDLE_MS (300000), GLANCE_JOB_TIMEOUT_MS (120000),
GLANCE_DOWNLOAD_TIMEOUT_MS (240000), GLANCE_GPU (1), GLANCE_ANGLE (auto), GLANCE_WEBGPU (1), GLANCE_BROWSER_ARGS,
GLANCE_LOW_PRIORITY (1), GLANCE_NO_SANDBOX, GLANCE_HEADLESS_SHELL, GLANCE_PLAYWRIGHT, GLANCE_EXECUTABLE,
GLANCE_LOG_MAX_BYTES (1048576). --port overrides GLANCE_PORT.`;

const here = path.dirname(fileURLToPath(import.meta.url));
const { pos, flags } = parseArgs(process.argv.slice(2));
const cmd = pos.shift();
if (flags.port) process.env.GLANCE_PORT = String(flags.port);
const cfg = loadConfig();
const BASE = `http://${cfg.host}:${cfg.port}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile(cfg), 'utf8')); } catch { return null; }
}

async function request(p, token, params) {
  const r = await fetch(BASE + p, {
    method: params ? 'POST' : 'GET',
    headers: { 'x-glance-token': token || '', ...(params ? { 'content-type': 'application/json' } : {}) },
    body: params ? JSON.stringify(params) : undefined,
  });
  return r.json();
}

async function health() { try { return await request('/health'); } catch { return null; } }

/** Status of a running server we own, or null. */
async function alive() {
  const s = readState();
  if (!s?.token) return null;
  try { const st = await request('/status', s.token); return st && st.name === 'glance' ? { ...st, token: s.token } : null; } catch { return null; }
}

async function ensure() {
  const a = await alive();
  if (a) { if (a.error) throw new Error('glance server failed to start the browser: ' + a.error); return a.token; }
  if (await health()) {
    throw new Error(`Port ${cfg.port} is taken by a glance server with a different GLANCE_HOME, or by another program. ` +
      'Use the same GLANCE_HOME, or pick another port with GLANCE_PORT / --port.');
  }
  fs.mkdirSync(cfg.home, { recursive: true });
  // Keep the log bounded: one previous generation, rotated when the server starts.
  try { if (fs.statSync(logFile(cfg)).size > cfg.logMaxBytes) fs.renameSync(logFile(cfg), logFile(cfg) + '.1'); } catch { /* no log yet */ }
  const logFd = fs.openSync(logFile(cfg), 'a');
  const child = spawn(process.execPath, [path.join(here, 'server.mjs')], {
    detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true, env: { ...process.env, GLANCE_PORT: String(cfg.port) },
  });
  child.unref();
  fs.closeSync(logFd);
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    const s = await alive();
    if (s) { if (s.error) throw new Error('glance server failed to start the browser: ' + s.error); return s.token; }
  }
  throw new Error('glance server did not start within 30 s; see ' + logFile(cfg));
}

const JOBS = new Set(['shot', 'shots', 'measure', 'download']);

try {
  let out;
  if (!cmd || cmd === 'help' || flags.help) { console.log(HELP); process.exit(0); }
  if (cmd === 'version') { console.log(VERSION); process.exit(0); }
  if (cmd === 'status') {
    const a = await alive();
    out = a ? (({ token, ...rest }) => rest)(a) : { ok: false, running: false, port: cfg.port };
  } else if (cmd === 'stop') {
    const a = await alive();
    out = a ? await request('/stop', a.token, {}) : { ok: true, running: false, port: cfg.port };
  } else if (JOBS.has(cmd)) {
    if (!pos[0]) throw new Error(`${cmd} needs a url (see: glance help)`);
    const params = { ...flags, url: pos[0] };
    delete params.port;
    // Paths are resolved here: the server runs in another working directory.
    for (const k of ['out', 'shot', 'outDir']) if (typeof params[k] === 'string') params[k] = path.resolve(params[k]);
    // A local file path is accepted too (with an optional ?query or #hash) and turned into a file:// URL.
    params.url = localToUrl(params.url, f => fs.existsSync(f), f => pathToFileURL(path.resolve(f)).href);
    if (cmd === 'download' && !params.outDir) throw new Error('download needs --out-dir');
    const token = await ensure();
    out = await request('/' + cmd, token, params);
  } else {
    throw new Error(`unknown command "${cmd}" (shot | shots | measure | download | status | stop | help)`);
  }
  console.log(JSON.stringify(out, null, 1));
  process.exitCode = out.ok === false && cmd !== 'status' ? 1 : 0;
} catch (e) {
  console.error('glance: ' + String(e.message || e));
  process.exitCode = 1;
}
