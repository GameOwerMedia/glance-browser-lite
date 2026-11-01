# glance HTTP API

The CLI is a thin wrapper around a local HTTP server. You can call it directly from any language.

- Address: `http://localhost:<port>` (default port `7333`, `GLANCE_PORT`). The server binds to the
  loopback interface only.
- Authentication: every route except `/health` requires the header `x-glance-token`. The token is
  generated at startup and stored in the state file `<GLANCE_HOME>/server-<port>.json`
  (mode `0600` on POSIX systems; on Windows it inherits the permissions of your user profile folder).
  The token is compared in constant time. Requests that carry an `Origin` header, or a `Host` header
  that does not name the loopback host (`localhost` or the IPv4 loopback address), are rejected, so web pages open in a browser
  cannot drive the server, even through DNS rebinding.
- Parameters: query string (`GET`) or a JSON body (`POST`). The names are the camelCase forms of the
  CLI options (`outDir`, `waitJs`, `domClick`, ...). Paths must be absolute: the server's working
  directory is not yours.

| Route | Purpose |
|---|---|
| `GET /health` | `{ ok, name: "glance", version }`. No token needed. |
| `GET /status` | Renderer, WebGPU probe result, queue length, open pages, idle time. Does not reset the idle timer. |
| `POST /shot` | See `shot` in [cli.md](cli.md). |
| `POST /shots` | `ts` is a comma-separated list. |
| `POST /measure` | |
| `POST /download` | `outDir` required. |
| `POST /stop` | Responds, then closes the browser and exits. |

Example with curl (POSIX shell; the default `GLANCE_HOME` shown is the Linux one, on macOS it is
`$HOME/Library/Caches/glance`):

```bash
STATE="${GLANCE_HOME:-$HOME/.cache/glance}/server-7333.json"
TOKEN=$(node --input-type=module -e 'import { readFileSync } from "node:fs"; process.stdout.write(JSON.parse(readFileSync(process.argv[1], "utf8")).token)' "$STATE")
curl -s -X POST http://localhost:7333/shot \
  -H "x-glance-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://example.com","out":"/tmp/example.png","width":1280,"height":720}'
```

The server must already be running (the CLI starts it; or run `node scripts/server.mjs` from the skill directory yourself).

## Lifecycle

1. The CLI reads the state file and calls `/status` with its token.
2. If nothing answers, it checks `/health`. If some other program (or a glance with another
   `GLANCE_HOME`) holds the port, it stops with an error instead of fighting over it.
3. Otherwise it spawns `server.mjs` detached, with output appended to `<GLANCE_HOME>/server-<port>.log`,
   and waits for the state file.
4. The server listens first and launches the browser second, so when two agents start it at the same
   moment, the loser exits on `EADDRINUSE` before spending a browser launch.
5. Jobs are chained on a single promise: exactly one page is open at a time. Each job has a hard limit
   (`GLANCE_JOB_TIMEOUT_MS`, downloads `GLANCE_DOWNLOAD_TIMEOUT_MS`); on timeout every page is closed
   so a hung page cannot block the queue or keep the GPU busy.
6. Every 15 s (or sooner with a short idle timeout) the server closes stray pages when the queue is empty,
   and exits after `GLANCE_IDLE_MS` without jobs.
