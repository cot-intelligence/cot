# cot desktop (Tauri)

`cot.app` for macOS with no Docker: a Tauri shell that starts the frozen Python
collector, shows the dashboard the collector serves, and updates itself.

The React UI and the backend are unchanged. The app bundles:

- `Contents/Resources/cot-collector/`, the collector frozen by PyInstaller
  (onedir, so launches don't unpack anything), built from
  `macos/packaging/cot-collector.spec`, which it shares with the Swift app
- `Contents/Resources/static/`, the vite build, passed to the collector as
  `COT_STATIC_DIR`

The Swift app in `macos/` uses the same bundle id (`run.cot.app`) and `~/.cot`.
Run one or the other, not both.

## Build

```sh
just desktop build     # cot.app
just desktop dmg       # cot.app + DMG
just desktop dev       # dev shell; stages the collector on first run
just desktop test      # Rust unit tests
just desktop verify    # bundled collector answers /health
```

Needs Rust, Node and Python 3.12. `scripts/prepare-collector.sh` builds the
dashboard and freezes the collector into `src-tauri/resources/`. Python deps go
into `desktop/build/venv`, never the host. The version comes from
`backend/app/__init__.py`; `scripts/build.sh` passes it to Tauri.

## How it runs

On launch the shell (`src-tauri/src/collector.rs`):

1. Resolves the port: `COT_PORT`, then `~/.cot/config.json`, then 31337.
2. Kills a collector left behind by a crashed app (`~/.cot/app-collector.pid`).
3. If something already answers `/health` on that port (the Docker install,
   the Swift app), shows "Another cot collector is using port N" and starts
   nothing. Two writers on one SQLite file is the thing to avoid.
4. Otherwise it spawns the collector on the first free port, waits up to 15s
   for `/health`, writes `~/.cot/config.json` so hooks follow the port, and
   loads `http://127.0.0.1:<port>`.

Collector output goes to `~/.cot/logs/collector.log`. Closing the window hides
it and keeps collecting; Quit stops the collector (SIGTERM, then SIGKILL after
5s). If the app dies without cleaning up, the collector sees its parent is
gone (`COT_PARENT_PID`) and exits.

The window only navigates to `127.0.0.1`/`localhost`; other links open in the
browser. The dashboard page gets one IPC permission, dragging the window by
its header.

## Updates

The updater reads the `platforms` block of `https://cot.run/version.json`,
checking on launch, every 6 hours, and from the tray. It asks before
installing, stops the collector, installs, and restarts. The collector's own
update banner is off in the app (`COT_DISABLE_UPDATE_CHECK=1`); browser and
Docker users still see it.

## Releasing

`.github/workflows/desktop-release.yml` runs on `v*` tags. It builds on
`macos-14` (Apple Silicon), runs `verify-bundle.sh`, uploads the DMG,
`cot.app.tar.gz` and `.sig` to the GitHub Release, and opens a PR on the site
repo that updates `public/version.json`. Merging that PR ships the update.

One-time setup:

- `npx tauri signer generate -w ~/.tauri/cot.key`: put the public key in
  `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`), and the private key
  and password in the `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets. Never commit the private key.
- Variable `SITE_REPO` (`cot-intelligence/website`) and secret
  `SITE_REPO_TOKEN`.
- Optional R2 mirror: variables `R2_ACCOUNT_ID` and `R2_BUCKET`, secrets
  `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`.

Builds are ad-hoc signed; there is no Developer ID yet. Gatekeeper warns on
the first download (right-click > Open, or
`xattr -dr com.apple.quarantine /Applications/cot.app`). Updates after that
are checked against the updater signature.
