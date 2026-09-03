# cot.app — the macOS app

A native SwiftUI shell around the collector. The collector runs in the
background as a child process of the app; the dashboard renders in a WKWebView
pointed at it. No Docker, no Python on the host.

```
cot.app/Contents/
  MacOS/cot                    SwiftUI shell (menu bar + window)
  Resources/cot-collector/     the FastAPI collector, frozen by PyInstaller
  Resources/static/            the dashboard, built by vite
```

## Build

```bash
macos/build.sh          # dashboard + collector + app → macos/build/cot.app
macos/build.sh --run    # …and launch it
macos/build.sh --app-only   # Swift only, when iterating on the shell
```

Python dependencies go into `macos/build/venv`; nothing is installed on the
host. Requires the Xcode Command Line Tools (`swiftc`, `codesign`) — full Xcode
is not needed.

The bundle is ad-hoc signed, which is enough to run locally and to register the
login item. For a distributable build set `COT_SIGN_IDENTITY` to a Developer ID
Application identity; the script then also enables the hardened runtime.

## Chrome

The stock titlebar is replaced with a 42pt brand bar: the app icon, and a live
status pill for the collector (state and port). Traffic lights, drag, and
double-click-to-zoom all still work.

The dashboard keeps its theme in `localStorage`, not in the system appearance,
so the bar can't read `colorScheme` — a user script reports `data-theme` back
over a `WKScriptMessageHandler` and the bar, the window background, and the
traffic lights follow the page.

`packaging/make_icon.swift` draws `AppIcon.icns` at build time from the same
mark as `public/apple-touch-icon.svg` — an ink squircle with the vermilion
italic wordmark — rendering each size at native pixels rather than downscaling
one master. The titlebar reads the icon back out of the bundle, so redesigning
the icon updates the Dock, the Finder, and the bar together.

## How it behaves at launch

The app resolves a port from `~/.cot/config.json` (default **31337**, same as
every other install path) and then:

| Situation | What happens |
|-----------|--------------|
| Nothing on the port | Spawns the bundled collector and renders it |
| A collector serving the dashboard | Attaches and renders it — the Docker install keeps working |
| An API-only collector (`docker compose up` in dev) | Says so, and offers the Vite dev server instead |
| Port busy, no collector | Takes the next free port and rewrites `config.json` so hooks follow |

Attaching rather than spawning is deliberate: two uvicorn processes writing one
SQLite file is the failure mode worth designing around.

## Lifetime

The collector is meant to outlive the window and die with the app.

- Closing the dashboard window leaves it collecting; the menu bar item stays.
- Quit, or SIGTERM, stops it through the app.
- Crash or `kill -9` is covered by a watchdog thread inside the collector that
  polls its parent pid and exits when the app is gone.
- A stale collector from a previous run is reaped at launch via
  `~/.cot/app-collector.pid`.

## State

Identical to every other install — nothing is app-specific:

| Path | What |
|------|------|
| `~/.cot/cot.db` | traces |
| `~/.cot/config.json` | endpoint the bridge reads |
| `~/.cot/logs/collector.log` | collector stdout/stderr |
| `~/.cot/app-collector.pid` | pid of the collector this app spawned |

Agent hooks are installed from the menu bar, which runs the same
`install.sh` the curl path uses — served by the collector the app just started.

## Overrides

| Variable | Purpose |
|----------|---------|
| `COT_PORT` | Force a port, bypassing `config.json` (useful for testing a second instance) |
| `COT_SIGN_IDENTITY` | Developer ID identity for a distributable build |
| `COT_PYTHON` | Python used to create the build venv (default `python3`) |
