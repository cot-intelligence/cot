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

There is no titlebar. The window is `fullSizeContentView` with a transparent,
title-less titlebar, so the dashboard renders edge to edge and its own header
row is the only header — the traffic lights sit on that row beside the wordmark.

Two pieces make that work, and they share their geometry through
`HeaderMetrics`:

- A user script pads the shell header down from the window edge and in past the
  buttons. It marks only the header at the top of the page — the app has other
  `<header>` elements nested inside pages — and re-marks on route changes.
- The titlebar is grown with an empty, hit-transparent accessory and the traffic
  lights are re-centred in it, since AppKit centres them at y=16 and puts them
  back there on every resize and full-screen transition.

That leaves the window with nothing to drag by: a transparent titlebar hands
every event to the web view. `WindowDragHandle` puts a handle back in the empty
middle of the header row, clear of the wordmark and the header controls. It is
installed into the window's frame view, not the SwiftUI hierarchy — a
representable in an `.overlay`, or a subview of the content view, draws in the
right place but never receives the mouse, because the hosting view hit-tests the
SwiftUI tree, finds nothing interactive, and passes the event down to the page.

The dashboard keeps its theme in `localStorage`, not in the system appearance,
so the window can't read `colorScheme` — the same user script reports
`data-theme` back and the window background and traffic lights follow the page.

`packaging/make_icon.swift` draws `AppIcon.icns` at build time from the same
mark as `public/apple-touch-icon.svg`, rendering each size at native pixels
rather than downscaling one master.

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
