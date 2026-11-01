# glance CLI reference

```
node glance.mjs <command> [url] [options]
```

Options are `--name value` or `--name=value`. Kebab-case and camelCase are equivalent
(`--out-dir` = `--outDir`). Relative paths are resolved against the directory you run the command in.
Output and exit codes:

- `shot`, `shots`, `measure`, `download` and `stop` print one JSON object on stdout. The exit code is 1
  when `ok` is false, otherwise 0. `stop` with no server running prints `"running": false` and exits 0.
- `status` prints one JSON object and always exits 0. With no server on the port it prints
  `{ "ok": false, "running": false, "port": <port> }`.
- `help` (also no command, or `--help`) and `version` print plain text and exit 0.
- Errors that happen before a job is queued (bad arguments, no server could start) are printed on
  stderr as `glance: <message>` with exit code 1.

## Commands

| Command | What it does |
|---|---|
| `shot <url>` | Load the page, run the interaction steps, save one PNG. |
| `shots <url> --ts a,b,c` | One page load and one PNG per timestamp (max 24). Files get a `-t<value>` suffix. |
| `measure <url>` | Record `requestAnimationFrame` timestamps for `--duration-ms` and return frame-time statistics. |
| `download <url> --out-dir DIR` | Load the page, run the interaction steps, save every file the page downloads. |
| `status` | Show the server on the current port (renderer, WebGPU probe, queue length, idle time). Does not count as activity. |
| `stop` | Stop the server on the current port and close its browser. |
| `help`, `version` | Usage summary, version number. |

The first job starts the server and the browser in the background if they are not running. This is a
one-time cost: on the test machine the first screenshot, including that start, took about 4.6 s;
later jobs skip it.

## Options for every job

| Option | Default | Meaning |
|---|---|---|
| `--width`, `--height` | `960`, `540` | Viewport in CSS pixels. |
| `--t` | none | Appended to the URL as `?t=<value>` (or `&t=`), placed before any `#hash`. For pages that can render a given moment of their animation. |
| `--t-param` | `t` | Name of that query parameter. |
| `--wait-ms` | `1500` (`measure`: `1000`) | Extra wait after the load event. |
| `--wait-until` | `load` | Playwright load state: `load`, `domcontentloaded`, `networkidle`, `commit`. |
| `--load-timeout-ms` | `30000` | Navigation timeout. |
| `--cookie` | none | `name=value`, set for the page's origin before loading. Use local test accounts, never a production session. |
| `--omit-background` | off | Transparent background instead of white (pages without their own background). |
| `--full-page` | off | Capture the whole scrollable page, not just the viewport. |
| `--port` | `GLANCE_PORT` or `7333` | Talk to (or start) the server on this port. |

## Interaction steps (`shot`, `shots`, `download`)

Run in this fixed order, each step only if given:

1. `--wait-js "<expression>"`: poll every 250 ms until the expression is truthy, at most `--wait-js-ms`
   (default 60000). Use it for pages that build a scene asynchronously.
2. `--fill "sel=value|sel2=value"`: fill text inputs.
3. `--select "sel=value|..."`: choose `<select>` options (fires `change`).
4. `--check "sel1,sel2"`: tick checkboxes (no-op when already ticked).
5. `--click "sel1,sel2"`: real pointer clicks, `--click-gap-ms` apart (default 300). The element must be
   visible and enabled.
6. `--dom-click "sel1,sel2"`: `element.click()` inside the page. Works on elements a real click refuses
   (hidden panels, zero-size controls). A checkbox toggles and fires `change`.

`--click-gap-ms` also applies after each `--dom-click`. After any step ran, glance waits `--after-ms`
(default 600) before the screenshot. Selectors for `--fill`, `--select`, `--check` and `--click` are
Playwright selectors (CSS by default; `text=Save` and similar also work); `--dom-click` takes CSS
selectors only (`document.querySelector`).
Pairs are separated by `|`, lists by `,`; the first `=` separates selector and value.

## `measure`

| Option | Default | Meaning |
|---|---|---|
| `--duration-ms` | `3000` | Sampling window, 250 to 10000. |
| `--fn` | none | Name of a global function; it is called synchronously `--fn-runs` times and timed. |
| `--fn-runs` | `10` | 1 to 1000. |
| `--refresh-hz` | measured | Frame rate the budget is computed from. Defaults to `frameRateHz` from `status`, measured when the server starts. |

Result fields: `frames` (timestamps recorded), `intervals`, `durationMs`, `fps`, `medianMs`, `p95Ms`,
`p99Ms`, `maxMs`, `budgetMs` (1000 / `--refresh-hz`), `longFrames` (intervals longer than 1.5 budgets: at
least one missed vsync), `droppedFrames` (vsyncs without a new frame), and `fn: {name, runs, medianMs,
maxMs}` when `--fn` was given. vsync and the frame-rate limit stay on, so a healthy page reports a median close to
`budgetMs`. Full Chromium in headless mode can follow the refresh rate of the attached display (for
example 143 Hz, about 7 ms); the headless shell and machines without a display run at 60 Hz.

Timer resolution in the page is about 0.1 ms (no cross-origin isolation), so very fast `--fn`
functions report `0`.

## `download`

| Option | Default | Meaning |
|---|---|---|
| `--out-dir` | required | Folder for the files (created if missing). |
| `--expect` | `1` | Number of files to wait for. |
| `--dl-timeout-ms` | `90000` | Maximum wait for them, capped by `GLANCE_DOWNLOAD_TIMEOUT_MS`. |
| `--prefix` | none | Prepended to each saved file name. |
| `--shot` | none | Screenshot of the same page after the downloads. |

Files keep the name the page suggested, with characters that are illegal on Windows, macOS or Linux
replaced by `_`. Anchor downloads, `blob:` URLs and server responses with `Content-Disposition` all work.

## Result fields common to all jobs

| Field | Meaning |
|---|---|
| `ok` | `true` on success. |
| `renderer` | WebGL renderer string of the shared browser. |
| `rendererWarning` | Present only when that renderer is a software rasterizer. |
| `errors` | Uncaught exceptions and `console.error` messages from the page (each cut at 300 chars). |
| `timing.queuedAhead` | Jobs that were in the queue when yours arrived. |
| `timing.waitMs`, `timing.runMs` | Time spent waiting for them, time your job took. |
| `via` | `cdp` or `canvas` when the normal screenshot path stalled and a fallback captured the frame. |
| `error` | Message when `ok` is false. |
