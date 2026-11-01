// glance server: ONE shared hidden Chromium for every agent on this machine, with a job queue.
// Jobs run one page at a time, so ten agents asking for screenshots never start ten browsers.
//
// Started on demand by glance.mjs (the client) and shuts itself down after GLANCE_IDLE_MS of idleness.
// Listens on 127.0.0.1 only and requires a per-instance token (stored in the state file, readable by
// the current user) on every job, so web pages open in other browsers cannot drive it.
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  VERSION, loadConfig, chromiumArgs, isSoftwareRenderer, withT, pairs, list, parseCookie,
  safeFileName, withSuffix, frameStats, clamp, stateFile, sameToken, isLoopbackHost,
} from './lib/core.mjs';
import { loadPlaywright } from './lib/playwright.mjs';

const cfg = loadConfig();
const STATE = stateFile(cfg);
const TOKEN = crypto.randomBytes(24).toString('hex');
fs.mkdirSync(cfg.home, { recursive: true });

// Lower our own priority BEFORE launching the browser: child processes inherit it on Windows
// (below-normal class), macOS and Linux (nice value), so the GPU-heavy renderer yields to the desktop.
if (cfg.lowPriority) { try { os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not permitted */ } }

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------------------------------------
// HTTP first, browser second: if another glance already owns the port we exit before spending
// a browser launch. Jobs that arrive while the browser starts simply wait for it.
let browser = null;
let renderer = 'starting';
let rendererWarning = null;
let webgpu = 'unknown';
let frameRateHz = 60;
let browserMode = 'starting';
let launchError = null;
let isReady = false;
let browserReady;
const ready = new Promise((res, rej) => { browserReady = { res, rej }; });
ready.catch(() => {});

let chain = Promise.resolve();
let queued = 0;
let lastActivity = Date.now();
let jobsDone = 0;

function enqueue(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function openPage(q, ctxOpts = {}) {
  const width = clamp(q.width, 16, 7680, 960), height = clamp(q.height, 16, 4320, 540);
  const ctx = await browser.newContext({ viewport: { width, height }, ...ctxOpts });
  // A failed load must close its context, otherwise the page keeps rendering on the GPU.
  try {
    const url = withT(q.url, q.t, q.tParam || 't');
    const c = parseCookie(q.cookie);
    if (c) await ctx.addCookies([{ name: c.name, value: c.value, url: new URL(url).origin }]);
    const page = await ctx.newPage();
    // Uncaught exceptions and console errors come back with the result: agents see broken pages.
    page.errors = [];
    page.on('pageerror', e => page.errors.push(String(e.message || e).slice(0, 300)));
    page.on('console', m => {
      if (m.type() !== 'error') return;
      // Full Chromium asks for /favicon.ico on its own; a missing one is not the page's error.
      if (/\/favicon\.ico(\?|$)/.test(m.location()?.url || '')) return;
      page.errors.push(('console: ' + m.text()).slice(0, 300));
    });
    await page.goto(url, { waitUntil: q.waitUntil || 'load', timeout: clamp(q.loadTimeoutMs, 1000, 120000, 30000) });
    const wait = clamp(q.waitMs, 0, 60000, 1500);
    if (wait) await page.waitForTimeout(wait);
    return { ctx, page };
  } catch (e) { await ctx.close().catch(() => {}); throw e; }
}

function outPath(out, suffix = '') {
  let p = out ? path.resolve(out) : path.join(cfg.home, 'shots', 'shot-' + Date.now() + '.png');
  p = withSuffix(p, suffix);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

// Heavy WebGL/WebGPU pages can stall Playwright's screenshot, which waits for a fresh compositor
// frame. Fallbacks: a raw CDP capture of the last frame, then the largest canvas read back inside a
// requestAnimationFrame right after the page drew it. Returns null for a normal shot, else the method.
async function capture(page, out, q = {}) {
  const transparent = q.omitBackground === true || q.omitBackground === 'true';
  const fullPage = q.fullPage === true || q.fullPage === 'true';
  try { await page.screenshot({ path: out, timeout: 20000, omitBackground: transparent, fullPage }); return null; } catch (e1) {
    try {
      const cdp = await page.context().newCDPSession(page);
      const r = await Promise.race([cdp.send('Page.captureScreenshot', { format: 'png' }),
        new Promise((_, no) => setTimeout(() => no(new Error('cdp timeout')), 20000))]);
      fs.writeFileSync(out, Buffer.from(r.data, 'base64')); return 'cdp';
    } catch {
      const data = await page.evaluate(() => new Promise(ok => requestAnimationFrame(() => {
        const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
        try { ok(c ? c.toDataURL('image/png') : null); } catch { ok(null); }
      })));
      if (!data || data.length < 2000) throw e1;
      fs.writeFileSync(out, Buffer.from(data.split(',')[1], 'base64')); return 'canvas';
    }
  }
}

// Optional interaction, shared by shot, shots and download, always in this order:
//   waitJs "expr"           wait until a page expression is truthy (max waitJsMs, default 60000)
//   fill "sel=value|..."    fill inputs
//   select "sel=value|..."  choose <select> options (fires change)
//   check "sel1,sel2"       tick checkboxes (no-op if already ticked)
//   click "sel1,sel2"       real pointer clicks, clickGapMs apart (default 300)
//   domClick "sel1,sel2"    element.click() inside the page, for controls a real click refuses
//                           (hidden panels, zero-size elements); a checkbox toggles and fires change
// then afterMs (default 600) if any step ran.
async function interact(page, q) {
  const gap = clamp(q.clickGapMs, 0, 10000, 300);
  if (q.waitJs) await page.waitForFunction(String(q.waitJs), null, { timeout: clamp(q.waitJsMs, 100, 600000, 60000), polling: 250 });
  for (const [sel, v] of pairs(q.fill)) await page.fill(sel, v, { timeout: 5000 });
  for (const [sel, v] of pairs(q.select)) await page.selectOption(sel, v, { timeout: 5000 });
  for (const sel of list(q.check)) await page.check(sel, { timeout: 5000 });
  for (const sel of list(q.click)) { await page.click(sel, { timeout: 5000 }); await page.waitForTimeout(gap); }
  for (const sel of list(q.domClick)) {
    const ok = await page.evaluate(s => { const e = document.querySelector(s); if (!e) return false; e.click(); return true; }, sel);
    if (!ok) throw new Error('domClick: no element matches ' + sel);
    await page.waitForTimeout(gap);
  }
  if (q.waitJs || q.fill || q.select || q.check || q.click || q.domClick) await page.waitForTimeout(clamp(q.afterMs, 0, 60000, 600));
}

async function doShot(q) {
  const { ctx, page } = await openPage(q);
  try {
    await interact(page, q);
    const out = outPath(q.out);
    const via = await capture(page, out, q);
    return { ok: true, path: out, renderer, errors: page.errors, ...(via ? { via } : {}) };
  } finally { await ctx.close(); }
}

async function doShots(q) {
  const ts = list(q.ts ?? q.t);
  if (!ts.length) throw new Error('shots needs ts=a,b,c');
  if (ts.length > 24) throw new Error('shots takes at most 24 timestamps per job');
  const shots = []; const errors = [];
  for (const t of ts) {
    const { ctx, page } = await openPage({ ...q, t });
    try {
      await interact(page, q);
      const out = outPath(q.out, '-t' + t);
      const via = await capture(page, out, q);
      shots.push({ t, path: out, ...(via ? { via } : {}) });
      errors.push(...page.errors.map(e => `t=${t}: ${e}`));
    } finally { await ctx.close(); }
  }
  return { ok: true, shots, renderer, errors };
}

async function doMeasure(q) {
  const { ctx, page } = await openPage({ ...q, waitMs: q.waitMs ?? 1000 });
  try {
    const ms = clamp(q.durationMs, 250, 10000, 3000);
    const stamps = await page.evaluate(ms => new Promise(resolve => {
      const ts = []; let start = null;
      const step = now => {
        if (start === null) start = now;
        ts.push(now);
        if (now - start < ms && ts.length < 4000) requestAnimationFrame(step); else resolve(ts);
      };
      requestAnimationFrame(step);
    }), ms);
    const res = { ok: true, ...frameStats(stamps, clamp(q.refreshHz, 1, 1000, frameRateHz)), renderer, errors: page.errors };
    if (q.fn) {
      const runs = clamp(q.fnRuns, 1, 1000, 10);
      res.fn = await page.evaluate(([name, runs]) => {
        const f = window[name];
        if (typeof f !== 'function') return { error: 'window.' + name + ' is not a function' };
        const times = [];
        for (let i = 0; i < runs; i++) { const a = performance.now(); f(); times.push(performance.now() - a); }
        times.sort((x, y) => x - y);
        return { name, runs, medianMs: +times[Math.floor(runs / 2)].toFixed(3), maxMs: +times[runs - 1].toFixed(3) };
      }, [q.fn, runs]);
    }
    return res;
  } finally { await ctx.close(); }
}

// download: open the page, run the interaction steps, accept every download the page starts
// (anchor or blob), wait until `expect` files arrived (default 1, max dlTimeoutMs, default 90000)
// and save them in outDir under their suggested names (optional prefix). Optional `shot` takes a
// screenshot of the same page afterwards, without a second load.
async function doDownload(q) {
  if (!q.outDir) throw new Error('download needs outDir');
  const expect = clamp(q.expect, 1, 100, 1);
  const outDir = path.resolve(q.outDir); fs.mkdirSync(outDir, { recursive: true });
  const { ctx, page } = await openPage(q, { acceptDownloads: true });
  try {
    const saved = []; const pending = [];
    let done; const all = new Promise(r => { done = r; });
    page.on('download', d => {
      pending.push((async () => {
        const name = safeFileName((q.prefix || '') + d.suggestedFilename());
        const file = path.join(outDir, name);
        const failure = await d.failure();
        if (failure) saved.push({ name, error: failure });
        else { await d.saveAs(file); saved.push({ name, path: file, bytes: fs.statSync(file).size }); }
        if (saved.length >= expect) done();
      })());
    });
    await interact(page, q);
    const dlMs = clamp(q.dlTimeoutMs, 1000, cfg.downloadTimeoutMs, 90000);
    let timer; await Promise.race([all, new Promise(r => { timer = setTimeout(r, dlMs); })]); clearTimeout(timer);
    await Promise.allSettled(pending);
    const res = { ok: saved.length >= expect && saved.every(s => !s.error), files: saved, expected: expect, outDir, renderer, errors: page.errors };
    if (saved.length < expect) res.error = `only ${saved.length} of ${expect} downloads within ${dlMs / 1000} s`;
    if (q.shot) { const out = outPath(q.shot); const via = await capture(page, out, q); res.shot = out; if (via) res.via = via; }
    return res;
  } finally { await ctx.close(); }
}

const JOBS = { '/shot': doShot, '/shots': doShots, '/measure': doMeasure, '/download': doDownload };

async function closeAllContexts() {
  if (!browser) return;
  for (const c of browser.contexts()) await c.close().catch(() => {});
}

// Hard limit per job: a hung page is closed instead of blocking the queue and the GPU.
function withLimit(fn, q) {
  const ms = fn === doDownload ? cfg.downloadTimeoutMs : cfg.jobTimeoutMs;
  let timer;
  const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`job timed out after ${ms / 1000} s, page closed`)), ms); });
  return Promise.race([fn(q), limit]).catch(async e => { await closeAllContexts(); throw e; }).finally(() => clearTimeout(timer));
}

let stopping = false;
async function shutdown(reason) {
  if (stopping) return; stopping = true;
  log('shutdown:', reason);
  try { if (browser) await browser.close(); } catch { /* already gone */ }
  try { const s = JSON.parse(fs.readFileSync(STATE, 'utf8')); if (s.pid === process.pid) fs.unlinkSync(STATE); } catch { /* no state */ }
  server.close();
  setTimeout(() => process.exit(0), 200).unref();
}

function status() {
  return {
    ok: true, name: 'glance', version: VERSION, pid: process.pid, port: cfg.port, browser: browserMode, sandbox: cfg.sandbox, renderer, frameRateHz, webgpu,
    ...(launchError ? { ok: false, error: launchError } : {}),
    queued, jobsDone, openPages: browser ? browser.contexts().length : 0, idleMs: Date.now() - lastActivity,
    idleShutdownMs: cfg.idleMs,
  };
}

async function readBody(req) {
  if (req.method !== 'POST') return {};
  let s = '';
  for await (const chunk of req) { s += chunk; if (s.length > 1e6) throw new Error('body too large'); }
  return s ? JSON.parse(s) : {};
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    if (rendererWarning && obj && typeof obj === 'object') obj.rendererWarning = rendererWarning;
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const u = new URL(req.url, 'http://127.0.0.1');
  // Health is the only unauthenticated route and reveals nothing but the name.
  if (u.pathname === '/health') return send(200, { ok: true, name: 'glance', version: VERSION });
  // Browsers attach Origin to cross-site requests; the CLI never does. The Host header must name the
  // loopback interface (DNS rebinding), and the token is compared in constant time.
  if (req.headers.origin || !isLoopbackHost(req.headers.host, cfg.port) || !sameToken(req.headers['x-glance-token'], TOKEN)) return send(403, { ok: false, error: 'forbidden' });
  // /status must not count as activity, or polling would keep the browser alive forever.
  if (u.pathname === '/status') return send(200, status());
  lastActivity = Date.now();
  try {
    if (u.pathname === '/stop') { send(200, { ok: true, stopping: true }); return setTimeout(() => shutdown('stop requested'), 50); }
    const fn = JOBS[u.pathname];
    if (!fn) return send(404, { ok: false, error: 'unknown endpoint ' + u.pathname });
    const q = { ...Object.fromEntries(u.searchParams), ...(await readBody(req)) };
    if (!q.url) return send(400, { ok: false, error: 'url required' });
    if (!/^(https?|file|data):/i.test(q.url)) return send(400, { ok: false, error: 'url must be http(s), file or data' });
    const position = queued++;
    const t0 = Date.now(); let t1 = t0;
    try {
      const result = await enqueue(async () => { t1 = Date.now(); await ready; return withLimit(fn, q); });
      jobsDone++;
      send(200, { ...result, timing: { queuedAhead: position, waitMs: t1 - t0, runMs: Date.now() - t1 } });
    } finally { queued--; lastActivity = Date.now(); }
  } catch (e) { send(500, { ok: false, error: String(e.message || e).split('\n')[0] }); }
});

server.on('error', e => {
  // Port taken (usually: another glance won the race). Leave it alone and exit quietly.
  log('listen error:', e.code || e.message);
  process.exit(e.code === 'EADDRINUSE' ? 0 : 1);
});

server.listen(cfg.port, cfg.host, async () => {
  log(`glance ${VERSION} listening on ${cfg.host}:${cfg.port}`);
  try {
    const chromium = await loadPlaywright(cfg.playwright);
    const args = chromiumArgs(cfg);
    const base = { headless: true, args, chromiumSandbox: cfg.sandbox };
    // Full Chromium in its new headless mode is the same browser users run, with the same frame pacing.
    // The lighter headless shell is the fallback (or the choice, with GLANCE_HEADLESS_SHELL=1).
    if (cfg.executablePath) { browser = await chromium.launch({ ...base, executablePath: cfg.executablePath }); browserMode = 'custom executable'; }
    else if (!cfg.headlessShell) {
      try { browser = await chromium.launch({ ...base, channel: 'chromium' }); browserMode = 'chromium (new headless)'; }
      catch (e) { log('full Chromium failed, using the headless shell:', String(e.message || e).split('\n')[0]); }
    }
    if (!browser) { browser = await chromium.launch(base); browserMode = 'chromium-headless-shell'; }
    browser.on('disconnected', () => { if (!stopping) shutdown('browser disconnected'); });
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    renderer = await p.evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return 'no-webgl';
      const e = gl.getExtension('WEBGL_debug_renderer_info');
      return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'no-debug-info';
    });
    // WebGPU exists only in secure contexts, so the probe runs on a routed https page that never hits the network.
    await p.route('https://glance.invalid/**', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>probe</title>' }));
    await p.goto('https://glance.invalid/probe').catch(() => {});
    webgpu = await p.evaluate(async () => {
      if (!('gpu' in navigator)) return 'unavailable (navigator.gpu missing)';
      try {
        const a = await navigator.gpu.requestAdapter();
        if (!a) return 'unavailable (no adapter)';
        const d = await a.requestDevice(); d.destroy();
        const i = a.info || {};
        return 'ok' + (i.vendor || i.architecture ? ` (${[i.vendor, i.architecture].filter(Boolean).join(' ')})` : '');
      } catch (e) { return 'requestDevice failed: ' + String(e.message || e).split('\n')[0].slice(0, 200); }
    }).catch(e => 'probe failed: ' + String(e.message || e).slice(0, 160));
    // The frame rate the browser actually runs at (headless Chromium may follow the display's vsync).
    const ivals = await p.evaluate(() => new Promise(res => { const ts = []; const s = n => { ts.push(n); if (ts.length < 40) requestAnimationFrame(s); else res(ts.slice(1).map((x, i) => x - ts[i])); }; requestAnimationFrame(s); })).catch(() => []);
    if (ivals.length) {
      const med = [...ivals].sort((a, b) => a - b)[Math.floor(ivals.length / 2)];
      const rates = [24, 30, 48, 50, 60, 72, 75, 90, 100, 120, 143, 144, 165, 240, 360];
      frameRateHz = rates.reduce((best, r) => Math.abs(1000 / r - med) < Math.abs(1000 / best - med) ? r : best, 60);
    }
    await ctx.close();
    if (isSoftwareRenderer(renderer)) rendererWarning = `software renderer (${renderer}): GPU acceleration is off, frame timings are not representative`;
    log('browser ready:', browserMode, '| sandbox:', cfg.sandbox, '| renderer:', renderer, '| frame rate:', frameRateHz, 'Hz | webgpu:', webgpu, '| args:', args.join(' '));
    // The idle clock starts when the browser is ready: a slow launch (cold start, CI) is not idleness,
    // and no client can send a job before the state file with the token exists.
    lastActivity = Date.now();
    isReady = true;
    browserReady.res();
    const state = { pid: process.pid, port: cfg.port, token: TOKEN, version: VERSION, renderer, started: new Date().toISOString() };
    fs.writeFileSync(STATE, JSON.stringify(state, null, 1), { mode: 0o600 });
    try { fs.chmodSync(STATE, 0o600); } catch { /* POSIX only */ }
  } catch (e) {
    log('browser launch failed:', e.message);
    browserReady.rej(e);
    renderer = 'failed';
    launchError = String(e.message || e).split('\n')[0];
    if (/sandbox/i.test(String(e.message))) launchError += ' (the Chromium sandbox could not start; in containers or CI without user namespaces set GLANCE_NO_SANDBOX=1, see SECURITY.md)';
    // Write the state anyway so the client can read the error from /status instead of timing out.
    fs.writeFileSync(STATE, JSON.stringify({ pid: process.pid, port: cfg.port, token: TOKEN, version: VERSION, error: String(e.message || e) }, null, 1), { mode: 0o600 });
    try { fs.chmodSync(STATE, 0o600); } catch { /* POSIX only */ }
    setTimeout(() => shutdown('browser launch failed'), 3000);
  }
});

setInterval(() => {
  // Nothing queued: no page may stay open (a leftover page keeps burning the GPU).
  if (isReady && queued === 0 && browser.contexts().length) closeAllContexts();
  // While the browser is still launching the server is not idle (a failed launch shuts down on its own).
  if (isReady && queued === 0 && Date.now() - lastActivity > cfg.idleMs) shutdown('idle');
}, Math.min(15000, Math.max(1000, cfg.idleMs / 4))).unref();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(sig));
