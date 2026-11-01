// Pure helpers shared by the glance server and client. No browser, no network, no side effects,
// so everything here is unit-tested directly (tests/core.test.mjs).
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const VERSION = '0.1.0';
export const DEFAULT_PORT = 7333;

const num = (v, d) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const flag = (v, d) => (v === undefined || v === '' ? d : !/^(0|false|no|off)$/i.test(String(v)));

/** Per-user cache directory for state files and default screenshot output. */
export function defaultHome(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'glance');
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Caches', 'glance');
  return path.posix.join(env.XDG_CACHE_HOME || path.posix.join(home, '.cache'), 'glance');
}

/** All runtime configuration, read from environment variables (see README, "Configuration"). */
export function loadConfig(env = process.env, platform = process.platform) {
  return {
    port: num(env.GLANCE_PORT, DEFAULT_PORT),
    host: '127.0.0.1',
    home: env.GLANCE_HOME ? path.resolve(env.GLANCE_HOME) : defaultHome(env, platform),
    idleMs: num(env.GLANCE_IDLE_MS, 5 * 60 * 1000),
    jobTimeoutMs: num(env.GLANCE_JOB_TIMEOUT_MS, 120000),
    downloadTimeoutMs: num(env.GLANCE_DOWNLOAD_TIMEOUT_MS, 240000),
    gpu: flag(env.GLANCE_GPU, true),
    angle: env.GLANCE_ANGLE || 'auto',
    webgpu: flag(env.GLANCE_WEBGPU, true),
    extraArgs: splitArgs(env.GLANCE_BROWSER_ARGS),
    executablePath: env.GLANCE_EXECUTABLE || undefined,
    playwright: env.GLANCE_PLAYWRIGHT || undefined,
    lowPriority: flag(env.GLANCE_LOW_PRIORITY, true),
    sandbox: !flag(env.GLANCE_NO_SANDBOX, false),
    headlessShell: flag(env.GLANCE_HEADLESS_SHELL, false),
    logMaxBytes: num(env.GLANCE_LOG_MAX_BYTES, 1024 * 1024),
  };
}

/** Split a flags string like `--a --b=c "--d=e f"` into an argv array. */
export function splitArgs(s) {
  if (!s) return [];
  const out = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const ANGLE_BY_PLATFORM = { win32: 'd3d11', darwin: 'metal' };

/**
 * Chromium flags: GPU on and the blocklist ignored, WebGPU enabled. Headless mode itself is chosen
 * by Playwright (see server.mjs: full Chromium in new headless mode, or the headless shell).
 * Deliberately never adds --disable-gpu-vsync or --disable-frame-rate-limit: frames stay paced the
 * way Chromium normally paces them, so timings are comparable between runs.
 */
export function chromiumArgs(cfg, platform = process.platform) {
  const args = [];
  if (cfg.gpu) {
    args.push('--enable-gpu', '--ignore-gpu-blocklist');
    const angle = cfg.angle === 'auto' ? ANGLE_BY_PLATFORM[platform] : cfg.angle;
    if (angle && angle !== 'none') args.push('--use-angle=' + angle);
  }
  if (cfg.webgpu) args.push('--enable-unsafe-webgpu');
  const forbidden = /^--(disable-gpu-vsync|disable-frame-rate-limit)\b/;
  for (const a of cfg.extraArgs || []) if (!forbidden.test(a)) args.push(a);
  return args;
}

/** True when the WebGL renderer string names a software rasterizer (no real GPU). */
export const isSoftwareRenderer = r => /swiftshader|llvmpipe|softpipe|software|basic render/i.test(String(r || ''));

/**
 * Put `t` (seconds into an animation) into the query string. A #hash is kept intact,
 * so `page.html#scene=3` becomes `page.html?t=5#scene=3`.
 */
export function withT(url, t, name = 't') {
  if (t === undefined || t === null || t === '') return url;
  const h = url.indexOf('#');
  const base = h < 0 ? url : url.slice(0, h), hash = h < 0 ? '' : url.slice(h);
  return base + (base.includes('?') ? '&' : '?') + encodeURIComponent(name) + '=' + encodeURIComponent(t) + hash;
}

/** `"a=1|b=x=y"` -> [['a','1'],['b','x=y']] (selector=value pairs, split on the first '='). */
export function pairs(s) {
  return String(s || '').split('|').filter(Boolean).map(p => {
    const i = p.indexOf('=');
    if (i < 1) throw new Error('expected selector=value, got: ' + p);
    return [p.slice(0, i), p.slice(i + 1)];
  });
}

/** `"#a, .b"` -> ['#a', '.b'] */
export const list = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

/** `"session=abc"` -> { name, value } or null. */
export function parseCookie(s) {
  const m = /^([^=;\s]+)=([^;]*)$/.exec(String(s || ''));
  return m ? { name: m[1], value: m[2] } : null;
}

/** Strip characters that are illegal in file names on any of Windows, macOS, Linux. */
export const safeFileName = s => String(s || 'download').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/^\.+/, '_').slice(0, 200) || 'download';

/** Insert a suffix before the .png extension: shot.png + -t5 -> shot-t5.png */
export function withSuffix(p, suffix) {
  if (!suffix) return p;
  return /\.png$/i.test(p) ? p.replace(/\.png$/i, suffix + '.png') : p + suffix + '.png';
}

/**
 * Frame-time statistics from requestAnimationFrame timestamps (ms), against a frame budget of
 * 1000/refreshHz ms (16.7 ms at 60 Hz; the server passes the frame rate it measured at startup).
 *   longFrames     intervals longer than 1.5 budgets, i.e. at least one missed vsync
 *   droppedFrames  vsyncs that produced no frame: sum over intervals of round(interval/budget) - 1
 */
export function frameStats(stamps, refreshHz = 60) {
  const budget = 1000 / refreshHz;
  const d = [];
  for (let i = 1; i < stamps.length; i++) d.push(stamps[i] - stamps[i - 1]);
  const base = { frames: stamps.length, intervals: d.length, budgetMs: +budget.toFixed(2) };
  if (!d.length) return { ...base, durationMs: 0, fps: null, medianMs: null, p95Ms: null, p99Ms: null, maxMs: null, longFrames: 0, droppedFrames: 0 };
  const s = [...d].sort((a, b) => a - b);
  const at = f => +s[Math.min(s.length - 1, Math.floor(s.length * f))].toFixed(2);
  const duration = stamps[stamps.length - 1] - stamps[0];
  return {
    ...base,
    durationMs: +duration.toFixed(1),
    fps: duration > 0 ? +(d.length / (duration / 1000)).toFixed(1) : null,
    medianMs: at(0.5),
    p95Ms: at(0.95),
    p99Ms: at(0.99),
    maxMs: +s[s.length - 1].toFixed(2),
    longFrames: d.filter(x => x > budget * 1.5).length,
    droppedFrames: d.reduce((n, x) => n + Math.max(0, Math.round(x / budget) - 1), 0),
  };
}

/** Clamp helper for request parameters. */
export const clamp = (v, lo, hi, d) => Math.min(hi, Math.max(lo, num(v, d)));

/** Turn `--out-dir` into `outDir`. */
export const camel = k => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** Flags that never take a value, so `shot --full-page app.html` keeps app.html as the URL. */
export const BOOLEAN_FLAGS = new Set(['fullPage', 'omitBackground', 'help']);

/**
 * Parse CLI arguments: positional args and `--name value` / `--name=value` flags.
 * Flag names are normalised to camelCase. Boolean flags (BOOLEAN_FLAGS) never consume the next
 * token; any other flag followed by another flag (or nothing) is `true`.
 */
export function parseArgs(argv) {
  const flags = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      if (eq > 0) { flags[camel(a.slice(2, eq))] = a.slice(eq + 1); continue; }
      const name = camel(a.slice(2));
      const next = argv[i + 1];
      flags[name] = BOOLEAN_FLAGS.has(name) || next === undefined || next.startsWith('--') ? true : (i++, next);
    } else pos.push(a);
  }
  return { pos, flags };
}

/**
 * Turn a local file path into a file:// URL, keeping a ?query and #hash that follow it:
 * `examples/orbit.html?n=40000#x` -> `file:///abs/examples/orbit.html?n=40000#x`.
 * Returns the input unchanged when it already has a URL scheme or names no existing file.
 */
export function localToUrl(input, exists, toFileUrl) {
  if (/^(https?|file|data):/i.test(input)) return input;
  const cut = input.search(/[?#]/);
  const file = cut < 0 ? input : input.slice(0, cut);
  const rest = cut < 0 ? '' : input.slice(cut);
  return file && exists(file) ? toFileUrl(file) + rest : input;
}

/** Constant-time string comparison for the access token. */
export function sameToken(a, b) {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** Host header must name the loopback interface (defence against DNS rebinding). */
export function isLoopbackHost(host, port) {
  const h = String(host || '').toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === '127.0.0.1' || h === 'localhost';
}

/** File holding the running server's pid, port and access token. One per port. */
export const stateFile = cfg => path.join(cfg.home, `server-${cfg.port}.json`);
export const logFile = cfg => path.join(cfg.home, `server-${cfg.port}.log`);
