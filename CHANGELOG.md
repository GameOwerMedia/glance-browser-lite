# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-25

### Added
- Shared headless Chromium server with a FIFO job queue: one page at a time, hard timeout per job,
  stray-page cleanup and idle shutdown.
- CLI that starts the server on demand: `shot`, `shots`, `measure`, `download`, `status`, `stop`.
  Local file paths are accepted as URLs.
- Interaction steps: `--wait-js`, `--fill`, `--select`, `--check`, `--click`, `--dom-click`.
- Frame-time statistics against the frame rate the browser runs at; optional timing of a page function.
- Downloads of anchor, `blob:` and `Content-Disposition` files.
- Screenshot fallbacks for pages that stall the compositor; WebGPU probe in `status`.
- Configuration through `GLANCE_*` environment variables; independent instances on different ports.
- Loopback-only HTTP API with a per-instance token, `Origin` rejection and a `Host` check.
- Claude Code plugin and marketplace manifests.
