# Troubleshooting

Start with `glance status`: it shows the renderer, the WebGPU probe and the queue. The server log is
`<GLANCE_HOME>/server-<port>.log` (see the configuration table in the README for the default
`GLANCE_HOME` on each platform).

## "Playwright not found"

glance does not bundle a browser. Install Playwright and its Chromium once:

```bash
npm install -g playwright
playwright install chromium
# Linux, if Chromium fails to start because of missing system libraries:
playwright install-deps chromium
```

Run `playwright` from the same installation glance loads: after a global install, the global `playwright`
command; after a project-local install (`npm i -D playwright` next to the skill or in any parent folder),
`npx playwright install chromium` in that project. Mixing them can install browsers for a different
Playwright version than the one glance uses.
To use an existing installation elsewhere, set `GLANCE_PLAYWRIGHT` to its package folder or
`index.mjs`. To use a different Chromium build, set `GLANCE_EXECUTABLE` to its executable.

## "the Chromium sandbox could not start"

glance runs Chromium with its sandbox on. Some Linux environments do not allow it: containers without
user namespaces, and CI images where AppArmor restricts unprivileged user namespaces (recent Ubuntu).
If you only load pages you trust there, set `GLANCE_NO_SANDBOX=1`. Do not turn the sandbox off on a
workstation that loads arbitrary sites; see the
[security policy](https://github.com/GameOwerMedia/glance-browser-lite/security/policy).

## Full Chromium vs. the headless shell

glance launches Playwright's full Chromium in its new headless mode, the same browser users run. If that
build is missing it falls back to the lighter `chromium-headless-shell`, and `status` shows which one
runs (`browser`). Force the shell with `GLANCE_HEADLESS_SHELL=1`. The two can differ in frame pacing:
the shell runs at a fixed 60 Hz, full Chromium may follow the display's refresh rate (`frameRateHz`).

## "Port 7333 is taken"

Another program, or a glance server started with a different `GLANCE_HOME`, holds the port. Either use
the same `GLANCE_HOME` everywhere, or pick another port: `GLANCE_PORT=7444` (environment) or
`--port 7444` (one command). Several glance servers on different ports are fine, for example a private
one for a test suite; each has its own state file and browser.

## `rendererWarning: software renderer`

The browser fell back to SwiftShader or llvmpipe. Screenshots still work, but frame timings and
WebGL/WebGPU performance are meaningless. Typical causes:

- No GPU available (CI runners, most containers, remote sessions without GPU passthrough). Expected;
  set `GLANCE_GPU=0` there to skip the GPU flags entirely.
- Linux: the default ANGLE backend did not pick up the GPU. Try `GLANCE_ANGLE=vulkan` or
  `GLANCE_ANGLE=gl`, and check that the user can access `/dev/dri`.
- Windows with several GPUs: the OS may give Chromium the integrated one. Set the GPU preference for the
  Node executable in the system graphics settings.

## WebGPU: `requestDevice failed` or `unavailable`

`status` reports the result of a WebGPU probe made at startup. glance passes `--enable-unsafe-webgpu`,
which is enough on most systems, but some combinations of OS, driver and Chromium build still fail.

- **Windows, error mentions `dxil.dll` or `EnsureDXCLibraries`.** Dawn (Chromium's WebGPU
  implementation) could not load the DXC shader compiler shipped with the browser build. Seen mostly
  with the headless shell (`status` shows `browser`); full Chromium usually loads it. Make Dawn use
  the older FXC compiler instead:

  ```bash
  GLANCE_BROWSER_ARGS="--disable-dawn-features=use_dxc"
  ```

  Restart the server (`glance stop`) after changing it. If `status` then shows `webgpu: ok`, keep the
  variable in your environment. Without it, pages that fall back from WebGPU to WebGL2 still render,
  just through a different path than your users may get.
- **Linux.** WebGPU in Chromium on Linux depends on Vulkan. Try `GLANCE_ANGLE=vulkan` and
  `GLANCE_BROWSER_ARGS="--enable-features=Vulkan"`.
- **No GPU.** WebGPU needs a real adapter; on software rendering the probe reports `no adapter`.

## A screenshot is black, blank or stale

- The page had not drawn yet: raise `--wait-ms`, or wait for a readiness flag with `--wait-js`.
- Heavy WebGL/WebGPU pages can stall Playwright's screenshot path. glance then falls back to a raw
  CDP capture and, failing that, reads the largest canvas back right after a frame (`via` in the
  result). A canvas read-back needs `preserveDrawingBuffer` or a capture inside the frame, which glance
  does; if the result is still black, the page may draw into a canvas inside a cross-origin iframe.

## A job times out

Each job has a hard limit (`GLANCE_JOB_TIMEOUT_MS`, default 120 s; downloads
`GLANCE_DOWNLOAD_TIMEOUT_MS`, default 240 s). On timeout glance closes all pages and moves on to the
next job. A `--wait-js` expression that never becomes true is the usual cause.

## The server keeps running / does not stop

It stops after `GLANCE_IDLE_MS` (default 5 minutes) without jobs; `status` calls do not keep it alive.
`glance stop` stops it immediately. glance never kills processes by name, and you should not either:
other agents may be in the middle of a job.
