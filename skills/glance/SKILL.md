---
name: glance
description: Look at a web page or measure how smoothly it animates, through one shared hidden GPU browser with a job queue. Use whenever you (or a subagent) need a screenshot of a URL or local HTML file, a frame at a given animation time, frame-time statistics (median/p95/p99), a file the page downloads, or a quick check for console errors. Use it instead of writing a Playwright script or launching another browser.
argument-hint: "shot|shots|measure|download|status|stop <url> [options]"
---

# glance

One hidden Chromium serves every agent and session on this machine. A small HTTP server on
`localhost` (port `7333` by default) queues jobs and runs them one page at a time, so several agents
asking at once wait in line instead of starting several GPU-hungry browsers. The server starts on
first use and stops itself after 5 idle minutes.

All commands print one JSON object. Exit code is 0 when `ok` is true; `status` always exits 0.

```bash
G="${CLAUDE_SKILL_DIR}/scripts/glance.mjs"

node "$G" shot <url> --out page.png                 # one screenshot, 960x540
node "$G" shot <url> --t 2.5 --out frame.png        # the frame at t=2.5 s (?t=2.5 or &t=2.5 is added before any #hash)
node "$G" shots <url> --ts 0.5,1,2 --out f.png      # f-t0.5.png, f-t1.png, f-t2.png
node "$G" measure <url>                             # frame-time stats over 3 s of requestAnimationFrame
node "$G" download <url> --click "#export" --out-dir exports
node "$G" status                                    # renderer, WebGPU, queue
node "$G" stop                                      # closes this server's own browser, nothing else
```

`<url>` may be `http(s)://`, `file://`, `data:` or a local file path.

## Rules

1. **Never launch your own browser** for viewing or measuring pages: no ad-hoc Playwright or Puppeteer
   scripts, no `headless: false`, no driving the user's everyday browser profile. Use glance.
2. **Single frames, not recordings.** To see an animation at a moment, pass `--t <seconds>`; pages that
   support it render that exact frame. Several moments: `shots --ts`.
3. **Small while iterating, large once.** Work at the default 960x540; use `--width 1920 --height 1080`
   only for the final check.
4. **Measurements are short and one at a time** (default 3 s, max 10 s). glance never disables vsync or
   the frame-rate limit, so frames are paced the way Chromium normally paces them. Compare numbers
   between runs on the same machine; they do not replace a measurement on a real device.
5. **Look at every screenshot you take** (open the PNG) before drawing conclusions: a black or blank
   frame is a finding, not a success.
6. **Read `errors`** in every result: uncaught exceptions and `console.error` lines from the page.
7. If a result contains `rendererWarning`, the browser fell back to a software renderer: screenshots
   are fine, frame timings are not representative. Say so in your report.
8. `stop` only stops the server on the current port. Never kill browser processes by name: other agents
   may be in the middle of a job.

## Options

Page (every job): `--width` (960), `--height` (540), `--t`, `--t-param` (name of the time parameter,
default `t`), `--wait-ms` (1500 after load; measure 1000), `--wait-until` (`load`), `--cookie name=value`
(a session for pages behind a login; use local test accounts only), `--full-page`, `--omit-background`
(transparent PNG).

Interaction (`shot`, `shots`, `download`), always run in this order:

| Step | Option | Example |
|---|---|---|
| wait for the page | `--wait-js "expr"` (`--wait-js-ms`, default 60000) | `--wait-js "window.sceneReady === true"` |
| fill inputs | `--fill "sel=value\|sel2=value"` | `--fill "#email=test@example.com"` |
| choose options | `--select "sel=value\|..."` | `--select "#size=xl"` |
| tick checkboxes | `--check "sel,sel2"` | `--check "#terms"` |
| real clicks | `--click "sel,sel2"` (`--click-gap-ms` 300) | `--click "#open,#confirm"` |
| in-page clicks | `--dom-click "sel,sel2"` | for controls a real click refuses (hidden panels) |

then `--after-ms` (600) before the screenshot.

`measure`: `--duration-ms` (3000), `--fn name` also times `window.name()` synchronously
(`--fn-runs`, default 10).

`download`: `--out-dir` (required), `--expect` (files to wait for, default 1), `--dl-timeout-ms`
(90000), `--prefix`, `--shot file.png` (screenshot after the downloads, same page).

Full reference: [references/cli.md](references/cli.md). HTTP API: [references/http-api.md](references/http-api.md).
Problems (port taken, software renderer, WebGPU unavailable): [references/troubleshooting.md](references/troubleshooting.md).

## Reading results

```json
{ "ok": true, "path": "/abs/page.png", "renderer": "ANGLE (...)", "errors": [],
  "timing": { "queuedAhead": 1, "waitMs": 1670, "runMs": 1830 } }
```

`timing.queuedAhead` is how many jobs were in front of yours; `waitMs` is time spent waiting for them.
`measure` adds `frames`, `fps`, `medianMs`, `p95Ms`, `p99Ms`, `maxMs`, `longFrames` (intervals longer
than 1.5 frame budgets, i.e. at least one missed vsync) and `droppedFrames` (vsyncs without a new frame).
A smooth page shows a median near `budgetMs` (1000 / the browser frame rate that `status` reports
as `frameRateHz`) and zero long frames. If a heavy WebGL/WebGPU page stalls the
normal screenshot path, the result carries `via: "cdp"` or `via: "canvas"`.

## Brief for subagents

Paste this into the prompt of any subagent that may need to look at a page:

> Browser rule: do not start your own browser. Use the shared hidden one:
> `node "<skill dir>/scripts/glance.mjs" shot <url> --t <sec> --out <png>` (also `shots`, `measure`,
> `download`, `status`). Single frames via `--t` instead of recordings; 960x540 while working,
> 1920x1080 only for the final check; measurements short and one at a time. Never disable vsync or the
> frame limit, never kill browser processes by name. Open every screenshot you take before judging it.
