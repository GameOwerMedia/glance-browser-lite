// End-to-end: a real glance server on a free port with a temporary GLANCE_HOME, driven through the CLI
// exactly as an agent would. Skipped (not failed) when Playwright or its Chromium is not installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../skills/glance/scripts/lib/playwright.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'skills', 'glance', 'scripts', 'glance.mjs');
const SCENE = fs.readFileSync(path.join(ROOT, 'examples', 'orbit.html'), 'utf8');

let skip = false;
try {
  const chromium = await loadPlaywright(process.env.GLANCE_PLAYWRIGHT);
  if (!fs.existsSync(chromium.executablePath())) skip = 'Chromium for Playwright is not installed (npx playwright install chromium)';
} catch (e) { skip = 'Playwright not installed'; }
// On CI a missing browser is a failure, not a silent skip.
if (skip && process.env.CI) throw new Error('end-to-end tests cannot run on CI: ' + skip);

const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

let tmp, port, site, siteUrl, env;

function glance(...args) {
  return new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], { env, cwd: tmp, timeout: 120000 }, (err, stdout, stderr) => {
      let json = null; try { json = JSON.parse(stdout); } catch { /* not json */ }
      resolve({ code: err ? (err.code ?? 1) : 0, json, stdout, stderr });
    });
  });
}

function pngSize(file) {
  const b = fs.readFileSync(file);
  assert.equal(b.subarray(1, 4).toString(), 'PNG', 'file is a PNG');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

before(async () => {
  if (skip) return;
  // realpath: on macOS os.tmpdir() is under /var, a symlink to /private/var, and the CLI resolves
  // relative paths against process.cwd(), which is always the real path.
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'glance-test-')));
  port = await freePort();
  // A tiny site: the example scene, a page that throws, and a page with two downloads.
  site = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'text/html');
    if (u.pathname === '/orbit.html') return res.end(SCENE);
    if (u.pathname === '/broken.html') return res.end('<script>console.error("boom-console"); throw new Error("boom-uncaught")</script>');
    if (u.pathname === '/cookie.html') return res.end(`<p id="c">${req.headers.cookie || 'none'}</p>`);
    if (u.pathname === '/two.html') return res.end(`<button id="go" onclick="for (const n of ['a.txt','b.txt']) { const a = document.createElement('a'); a.href = window.URL.createObjectURL(new Blob([n])); a.download = n; document.body.append(a); a.click(); }">go</button>`);
    if (u.pathname === '/report.csv') { res.setHeader('content-type', 'text/csv'); res.setHeader('content-disposition', 'attachment; filename="report.csv"'); return res.end('a,b\n1,2\n'); }
    if (u.pathname === '/link.html') return res.end('<a id="dl" href="/report.csv">report</a>');
    res.statusCode = 404; res.end('not found');
  });
  await new Promise(r => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${site.address().port}`;
  env = { ...process.env, GLANCE_PORT: String(port), GLANCE_HOME: path.join(tmp, 'home'), GLANCE_IDLE_MS: '60000' };
});

after(async () => {
  if (skip) return;
  await glance('stop');
  site.close();
  await new Promise(r => setTimeout(r, 500));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('status before first use: not running', { skip }, async () => {
  const r = await glance('status');
  assert.equal(r.json.running, false);
});

test('shot: starts the server, writes a PNG at the requested size, reports the renderer', { skip }, async () => {
  const r = await glance('shot', siteUrl + '/orbit.html', '--t', '2', '--out', 'orbit.png', '--width', '640', '--height', '360');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.path, path.join(tmp, 'orbit.png'));
  assert.deepEqual(pngSize(r.json.path), { width: 640, height: 360 });
  assert.equal(typeof r.json.renderer, 'string');
  assert.deepEqual(r.json.errors, []);
  assert.ok(r.json.timing.runMs > 0);
});

test('status: running, with renderer and webgpu probe, without the token', { skip }, async () => {
  const r = await glance('status');
  assert.equal(r.json.ok, true);
  assert.equal(r.json.name, 'glance');
  assert.equal(r.json.port, port);
  assert.equal(typeof r.json.webgpu, 'string');
  assert.equal(r.json.token, undefined);
  assert.equal(typeof r.json.frameRateHz, 'number');
  assert.equal(typeof r.json.browser, 'string');
  assert.equal(r.json.sandbox, !process.env.GLANCE_NO_SANDBOX);
});

test('the HTTP API refuses requests without the token or with an Origin header', { skip }, async () => {
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(base + '/health').then(r => r.json())).name, 'glance');
  assert.equal((await fetch(base + '/shot?url=' + encodeURIComponent(siteUrl + '/orbit.html'))).status, 403);
  const state = JSON.parse(fs.readFileSync(path.join(tmp, 'home', `server-${port}.json`), 'utf8'));
  const withOrigin = await fetch(base + '/status', { headers: { 'x-glance-token': state.token, origin: 'https://evil.example' } });
  assert.equal(withOrigin.status, 403);
  const ok = await fetch(base + '/status', { headers: { 'x-glance-token': state.token } });
  assert.equal(ok.status, 200);
  // DNS rebinding: a valid token with a foreign Host header is refused.
  const code = host => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: '/status', headers: { host, 'x-glance-token': state.token } }, r => { r.resume(); res(r.statusCode); }).on('error', rej));
  assert.equal(await code('evil.example'), 403);
  assert.equal(await code('evil.example:' + port), 403);
  assert.equal(await code('localhost:' + port), 200);
});

test('--omit-background gives an RGBA PNG; --full-page captures beyond the viewport', { skip }, async () => {
  const r = await glance('shot', 'data:text/html,<div style="height:900px">tall</div>', '--omit-background', '--full-page', '--out', 'clear.png', '--wait-ms', '0');
  assert.equal(r.json.ok, true, r.stderr);
  const b = fs.readFileSync(r.json.path);
  assert.equal(b[25], 6, 'PNG colour type 6 = RGBA');
  assert.ok(pngSize(r.json.path).height >= 900);
});

test('page errors come back with the result', { skip }, async () => {
  const r = await glance('shot', siteUrl + '/broken.html', '--out', 'broken.png', '--wait-ms', '200');
  assert.equal(r.json.ok, true);
  assert.ok(r.json.errors.some(e => e.includes('boom-uncaught')));
  assert.ok(r.json.errors.some(e => e.includes('boom-console')));
});

test('shots: one file per timestamp', { skip }, async () => {
  const r = await glance('shots', siteUrl + '/orbit.html', '--ts', '0.5,1.5', '--out', 'seq.png', '--wait-ms', '200');
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.shots.map(s => path.basename(s.path)), ['seq-t0.5.png', 'seq-t1.5.png']);
  for (const s of r.json.shots) assert.ok(fs.existsSync(s.path));
});

test('measure: frame-time statistics and a timed page function', { skip }, async () => {
  const r = await glance('measure', siteUrl + '/orbit.html', '--duration-ms', '600', '--wait-ms', '200', '--fn', 'stepScene', '--fn-runs', '5');
  assert.equal(r.json.ok, true);
  assert.ok(r.json.frames > 5, 'frames: ' + r.json.frames);
  for (const k of ['medianMs', 'p95Ms', 'p99Ms', 'maxMs', 'fps']) assert.equal(typeof r.json[k], 'number', k);
  assert.equal(r.json.fn.name, 'stepScene');
  assert.equal(r.json.fn.runs, 5);
});

test('download: interaction steps in order, files saved under their names, shot afterwards', { skip }, async () => {
  const r = await glance('download', siteUrl + '/orbit.html', '--t', '3', '--out-dir', 'dl',
    '--wait-js', 'window.sceneReady === true', '--fill', '#name=acme-shop', '--select', '#palette=warm',
    '--check', '#trails', '--click', '#export', '--shot', 'after.png', '--after-ms', '100');
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(r.json.files.length, 1);
  const data = JSON.parse(fs.readFileSync(r.json.files[0].path, 'utf8'));
  assert.deepEqual([data.title, data.palette, data.trails, data.t], ['acme-shop', 'warm', true, 3]);
  assert.ok(fs.existsSync(r.json.shot));
});

test('download: --dom-click reaches a control in a hidden panel; --expect waits for several files', { skip }, async () => {
  const hidden = await glance('download', siteUrl + '/orbit.html', '--t', '1', '--out-dir', 'dl2', '--dom-click', '#debug,#export', '--prefix', 'x-');
  assert.equal(hidden.json.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'dl2', 'x-orbit-scene.json'), 'utf8')).debug, true);
  const two = await glance('download', siteUrl + '/two.html', '--out-dir', 'dl3', '--click', '#go', '--expect', '2', '--wait-ms', '100');
  assert.equal(two.json.ok, true);
  assert.deepEqual(two.json.files.map(f => f.name).sort(), ['a.txt', 'b.txt']);
});

test('download: a server response with Content-Disposition', { skip }, async () => {
  const r = await glance('download', siteUrl + '/link.html', '--out-dir', 'dl6', '--click', '#dl', '--wait-ms', '100');
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  assert.equal(fs.readFileSync(r.json.files[0].path, 'utf8'), 'a,b\n1,2\n');
});

test('download: missing files fail cleanly after dl-timeout-ms', { skip }, async () => {
  const r = await glance('download', siteUrl + '/orbit.html', '--out-dir', 'dl4', '--dl-timeout-ms', '1000', '--wait-ms', '100');
  assert.equal(r.code, 1);
  assert.equal(r.json.ok, false);
  assert.match(r.json.error, /only 0 of 1/);
});

test('cookie is sent to the page origin', { skip }, async () => {
  const r = await glance('download', siteUrl + '/cookie.html', '--out-dir', 'dl5', '--cookie', 'session=test123', '--dl-timeout-ms', '1000', '--wait-ms', '100', '--shot', 'cookie.png');
  assert.ok(fs.existsSync(r.json.shot));
  const s = await glance('shot', siteUrl + '/cookie.html', '--cookie', 'session=test123', '--wait-js', 'document.getElementById("c").textContent.includes("session=test123")', '--wait-js-ms', '3000', '--out', 'cookie2.png');
  assert.equal(s.json.ok, true, JSON.stringify(s.json));
});

test('concurrent clients are queued, one page at a time', { skip }, async () => {
  const runs = await Promise.all([1, 2, 3].map(i => glance('shot', siteUrl + '/orbit.html', '--t', String(i), '--out', `q${i}.png`, '--wait-ms', '800')));
  for (const r of runs) assert.equal(r.json.ok, true);
  const ahead = runs.map(r => r.json.timing.queuedAhead).sort();
  assert.deepEqual(ahead, [0, 1, 2]);
  assert.ok(runs.some(r => r.json.timing.waitMs >= 250), 'a later job waited for the earlier ones');
});

test('bad input: unknown command, missing url, bad scheme', { skip }, async () => {
  assert.equal((await glance('frobnicate')).code, 1);
  assert.equal((await glance('shot')).code, 1);
  const r = await glance('shot', 'javascript:alert(1)');
  assert.equal(r.code, 1);
});

test('a local path with ?query keeps the query; boolean flags before the url', { skip }, async () => {
  fs.writeFileSync(path.join(tmp, 'orbit.html'), SCENE);
  const r = await glance('shot', 'orbit.html?n=3', '--t', '1', '--wait-js', 'document.getElementById("count").textContent === "3"', '--wait-js-ms', '5000', '--out', 'n3.png');
  assert.equal(r.json.ok, true, JSON.stringify(r.json) + r.stderr);
  const b = await glance('shot', '--full-page', siteUrl + '/orbit.html', '--omit-background', '--out', 'order.png', '--wait-ms', '0');
  assert.equal(b.json.ok, true, b.stderr);
});

test('a hung job is closed after GLANCE_JOB_TIMEOUT_MS; an idle server exits after GLANCE_IDLE_MS', { skip }, async () => {
  const p2 = await freePort();
  const env2 = { ...env, GLANCE_PORT: String(p2), GLANCE_JOB_TIMEOUT_MS: '2500', GLANCE_IDLE_MS: '3000' };
  const run2 = (...args) => new Promise(resolve => execFile(process.execPath, [CLI, ...args], { env: env2, cwd: tmp, timeout: 60000 }, (err, stdout, stderr) => {
    let json = null; try { json = JSON.parse(stdout); } catch { /* not json */ }
    resolve({ code: err ? 1 : 0, json, stderr });
  }));
  const hung = await run2('shot', siteUrl + '/orbit.html', '--wait-js', 'false', '--wait-js-ms', '60000', '--wait-ms', '0', '--out', 'hung.png');
  const log = () => { try { return fs.readFileSync(path.join(tmp, 'home', `server-${p2}.log`), 'utf8').slice(-2000); } catch { return '(no server log)'; } };
  const why = r => ['', `stdout: ${JSON.stringify(r.json)}`, `stderr: ${r.stderr}`, 'server log:', log()].join('\n');
  assert.equal(hung.code, 1, why(hung));
  assert.ok(hung.json, 'the CLI printed no JSON result' + why(hung));
  assert.match(hung.json.error, /timed out/, why(hung));
  const after = await run2('status');
  assert.equal(after.json?.openPages, 0, why(after));
  let running = true;
  for (let i = 0; i < 30 && running; i++) { await new Promise(r => setTimeout(r, 500)); running = (await run2('status')).json.running !== false; }
  assert.equal(running, false, 'server exited after the idle timeout');
});

test('stop: only this instance, state file removed', { skip }, async () => {
  const r = await glance('stop');
  assert.equal(r.json.stopping, true);
  await new Promise(res => setTimeout(res, 1500));
  assert.equal(fs.existsSync(path.join(tmp, 'home', `server-${port}.json`)), false);
  assert.equal((await glance('status')).json.running, false);
});

test('a port held by another program is reported, not fought over', { skip }, async () => {
  const other = http.createServer((req, res) => res.end('{"name":"something-else"}'));
  const p2 = await freePort();
  await new Promise(r => other.listen(p2, '127.0.0.1', r));
  try {
    const r = await glance('shot', siteUrl + '/orbit.html', '--port', String(p2));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /taken/);
  } finally { other.close(); }
});
