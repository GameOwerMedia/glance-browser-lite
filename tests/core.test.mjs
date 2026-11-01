import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  defaultHome, loadConfig, splitArgs, chromiumArgs, isSoftwareRenderer, withT, pairs, list,
  parseCookie, safeFileName, withSuffix, frameStats, clamp, parseArgs, stateFile, DEFAULT_PORT,
  localToUrl, sameToken, isLoopbackHost,
} from '../skills/glance/scripts/lib/core.mjs';

test('defaultHome follows each platform convention', () => {
  assert.equal(defaultHome({ LOCALAPPDATA: 'X:\\Local' }, 'win32', 'X:\\home'), 'X:\\Local\\glance');
  assert.equal(defaultHome({}, 'darwin', '/Users/a'), '/Users/a/Library/Caches/glance');
  assert.equal(defaultHome({}, 'linux', '/home/a'), '/home/a/.cache/glance');
  assert.equal(defaultHome({ XDG_CACHE_HOME: '/xdg' }, 'linux', '/home/a'), '/xdg/glance');
});

test('loadConfig reads env vars with sane defaults', () => {
  const d = loadConfig({}, 'linux');
  assert.equal(d.port, DEFAULT_PORT);
  assert.equal(d.host, '127.0.0.1');
  assert.equal(d.gpu, true);
  assert.equal(d.idleMs, 300000);
  const c = loadConfig({ GLANCE_PORT: '9001', GLANCE_HOME: 'rel/dir', GLANCE_GPU: '0', GLANCE_IDLE_MS: '1000', GLANCE_BROWSER_ARGS: '--a --b=c' }, 'linux');
  assert.equal(c.port, 9001);
  assert.equal(c.home, path.resolve('rel/dir'));
  assert.equal(c.gpu, false);
  assert.equal(c.idleMs, 1000);
  assert.deepEqual(c.extraArgs, ['--a', '--b=c']);
  assert.equal(loadConfig({ GLANCE_PORT: 'abc' }).port, DEFAULT_PORT);
});

test('splitArgs honours quotes', () => {
  assert.deepEqual(splitArgs('--x "--y=a b" \'--z=c\''), ['--x', '--y=a b', '--z=c']);
  assert.deepEqual(splitArgs(''), []);
});

test('chromiumArgs: GPU and ANGLE per platform, never disables vsync', () => {
  const base = { gpu: true, angle: 'auto', webgpu: true, extraArgs: [] };
  assert.ok(chromiumArgs(base, 'win32').includes('--use-angle=d3d11'));
  assert.ok(chromiumArgs(base, 'darwin').includes('--use-angle=metal'));
  assert.ok(!chromiumArgs(base, 'linux').some(a => a.startsWith('--use-angle')));
  assert.ok(chromiumArgs({ ...base, angle: 'vulkan' }, 'linux').includes('--use-angle=vulkan'));
  assert.ok(!chromiumArgs({ ...base, angle: 'none' }, 'win32').some(a => a.startsWith('--use-angle')));
  const off = chromiumArgs({ ...base, gpu: false, webgpu: false }, 'win32');
  assert.deepEqual(off, []);
  const filtered = chromiumArgs({ ...base, extraArgs: ['--disable-gpu-vsync', '--disable-frame-rate-limit', '--foo'] }, 'linux');
  assert.ok(filtered.includes('--foo'));
  assert.ok(!filtered.includes('--disable-gpu-vsync'));
  assert.ok(!filtered.includes('--disable-frame-rate-limit'));
});

test('isSoftwareRenderer', () => {
  assert.equal(isSoftwareRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))'), true);
  assert.equal(isSoftwareRenderer('llvmpipe (LLVM 15.0.7, 256 bits)'), true);
  assert.equal(isSoftwareRenderer('ANGLE (Acme, ANGLE Metal Renderer: Acme Zephyr, Unspecified Version)'), false);
});

test('withT keeps the hash and existing query', () => {
  assert.equal(withT('http://a/x', 5), 'http://a/x?t=5');
  assert.equal(withT('http://a/x?q=1', 5), 'http://a/x?q=1&t=5');
  assert.equal(withT('http://a/x#scene=2', 1.5), 'http://a/x?t=1.5#scene=2');
  assert.equal(withT('http://a/x?q=1#h', 0), 'http://a/x?q=1&t=0#h');
  assert.equal(withT('http://a/x', ''), 'http://a/x');
  assert.equal(withT('http://a/x', undefined), 'http://a/x');
  assert.equal(withT('http://a/x', 3, 'time'), 'http://a/x?time=3');
});

test('pairs and list', () => {
  assert.deepEqual(pairs('#a=1|#b=x=y'), [['#a', '1'], ['#b', 'x=y']]);
  assert.deepEqual(pairs(''), []);
  assert.throws(() => pairs('novalue'));
  assert.deepEqual(list(' #a, .b ,,'), ['#a', '.b']);
  assert.deepEqual(list(undefined), []);
});

test('parseCookie', () => {
  assert.deepEqual(parseCookie('session=abc'), { name: 'session', value: 'abc' });
  assert.equal(parseCookie('bad'), null);
  assert.equal(parseCookie('a=b; c=d'), null);
});

test('safeFileName and withSuffix', () => {
  assert.equal(safeFileName('a/b:c*.json'), 'a_b_c_.json');
  assert.equal(safeFileName('..\\secret'), '__secret');
  assert.equal(safeFileName(''), 'download');
  assert.equal(withSuffix('/x/shot.png', '-t5'), '/x/shot-t5.png');
  assert.equal(withSuffix('/x/shot', '-t5'), '/x/shot-t5.png');
  assert.equal(withSuffix('/x/shot.png', ''), '/x/shot.png');
});

test('frameStats on a steady 60 Hz trace with one hitch', () => {
  const stamps = [];
  let t = 1000;
  for (let i = 0; i < 181; i++) { stamps.push(t); t += i === 90 ? 50 : 16.667; }
  const s = frameStats(stamps);
  assert.equal(s.frames, 181);
  assert.equal(s.intervals, 180);
  assert.equal(s.medianMs, 16.67);
  assert.equal(s.maxMs, 50);
  assert.equal(s.longFrames, 1);
  assert.equal(s.droppedFrames, 2, '50 ms = three vsyncs for one frame');
  assert.equal(s.budgetMs, 16.67);
  assert.ok(s.fps > 55 && s.fps < 61);
  assert.equal(frameStats([5]).medianMs, null);
});

test('frameStats: a uniformly slow page still counts as long frames', () => {
  const stamps = Array.from({ length: 21 }, (_, i) => i * 100);
  const s = frameStats(stamps);
  assert.equal(s.medianMs, 100);
  assert.equal(s.longFrames, 20);
  assert.equal(s.droppedFrames, 100);
  assert.equal(frameStats(Array.from({ length: 11 }, (_, i) => i * 8.33), 120).longFrames, 0);
});

test('clamp', () => {
  assert.equal(clamp('5000', 0, 3000, 1), 3000);
  assert.equal(clamp(undefined, 0, 3000, 1500), 1500);
  assert.equal(clamp('-1', 0, 3000, 1), 0);
});

test('parseArgs: positional, --k v, --k=v, kebab to camel, booleans', () => {
  const { pos, flags } = parseArgs(['shot', 'http://x', '--out-dir', 'd', '--t=5', '--help', '--fill', '#a=1|#b=2']);
  assert.deepEqual(pos, ['shot', 'http://x']);
  assert.deepEqual(flags, { outDir: 'd', t: '5', help: true, fill: '#a=1|#b=2' });
});

test('parseArgs: boolean flags never consume the next token', () => {
  const { pos, flags } = parseArgs(['shot', '--full-page', 'app.html', '--omit-background', '--out', 'x.png']);
  assert.deepEqual(pos, ['shot', 'app.html']);
  assert.deepEqual(flags, { fullPage: true, omitBackground: true, out: 'x.png' });
});

test('localToUrl keeps ?query and #hash of local paths', () => {
  const exists = f => f === 'examples/orbit.html';
  const toUrl = f => 'file:///abs/' + f;
  assert.equal(localToUrl('examples/orbit.html?n=40000', exists, toUrl), 'file:///abs/examples/orbit.html?n=40000');
  assert.equal(localToUrl('examples/orbit.html#a?b', exists, toUrl), 'file:///abs/examples/orbit.html#a?b');
  assert.equal(localToUrl('examples/orbit.html', exists, toUrl), 'file:///abs/examples/orbit.html');
  assert.equal(localToUrl('https://x/y?z', exists, toUrl), 'https://x/y?z');
  assert.equal(localToUrl('missing.html?a', exists, toUrl), 'missing.html?a');
});

test('sameToken and isLoopbackHost', () => {
  assert.equal(sameToken('abc', 'abc'), true);
  assert.equal(sameToken('abc', 'abd'), false);
  assert.equal(sameToken('abc', 'abcd'), false);
  assert.equal(sameToken('', ''), false);
  assert.equal(sameToken(undefined, 'abc'), false);
  assert.equal(isLoopbackHost('127.0.0.1:7333', 7333), true);
  assert.equal(isLoopbackHost('localhost' + ':7333', 7333), true);
  assert.equal(isLoopbackHost('evil.example', 7333), false);
  assert.equal(isLoopbackHost('127.0.0.1:9999', 7333), false);
  assert.equal(isLoopbackHost(undefined, 7333), false);
});

test('sandbox is on unless GLANCE_NO_SANDBOX is set', () => {
  assert.equal(loadConfig({}).sandbox, true);
  assert.equal(loadConfig({ GLANCE_NO_SANDBOX: '1' }).sandbox, false);
  assert.equal(loadConfig({}).headlessShell, false);
});

test('stateFile is per port', () => {
  assert.notEqual(stateFile({ home: '/h', port: 1 }), stateFile({ home: '/h', port: 2 }));
});
