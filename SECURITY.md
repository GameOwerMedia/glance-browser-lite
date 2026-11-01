# Security policy

Report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/GameOwerMedia/glance-browser-lite/security/advisories/new),
not in a public issue. Only the latest 0.1.x release receives fixes.

## Threat model

- The server binds to the loopback interface only. Every job needs a random 192-bit token, compared in
  constant time and stored in `<GLANCE_HOME>/server-<port>.json` (mode `0600` on POSIX; on Windows it
  inherits your profile folder's permissions).
- Requests with an `Origin` header, or a `Host` header that does not name the loopback host
  (`localhost` or the IPv4 loopback address), are rejected, so web pages in your everyday browser
  cannot use glance, including through DNS rebinding.
- Any process running as your user can read the token and use the server. Jobs write files where the
  caller asks and can load `file://` URLs; treat access like access to your shell.
- Only load pages you trust. glance runs a real browser with GPU access, `--ignore-gpu-blocklist` and,
  by default, `--enable-unsafe-webgpu`. A loaded page can reach services on `localhost` and your local
  network like any page you open.
- The Chromium sandbox is on by default. `GLANCE_NO_SANDBOX=1` turns it off for containers and CI where
  it cannot start; never combine that with untrusted pages.
- Do not pass production session cookies with `--cookie`.
