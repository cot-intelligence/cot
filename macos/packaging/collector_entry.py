"""Entrypoint for the frozen collector shipped inside cot.app.

The Docker image runs `uvicorn app.main:app`; the Mac app has no shell, so this
module is the frozen binary's main and calls uvicorn programmatically. Host and
port come from the app, which has already picked a free port.
"""

import os
import sys
import threading
import time


def _watch_parent() -> None:
    """Exit when the app that spawned us goes away.

    The app stops the collector on quit, but a crash or `kill -9` never gets
    that chance and would leave a second writer on ~/.cot/cot.db. Polling the
    parent covers every exit path, including the ones no signal handler sees.
    """
    parent = int(os.environ["COT_PARENT_PID"])
    while True:
        try:
            os.kill(parent, 0)
        except OSError:
            os._exit(0)
        time.sleep(1)


def main() -> int:
    import uvicorn

    from app.main import app

    if os.environ.get("COT_PARENT_PID"):
        threading.Thread(target=_watch_parent, daemon=True).start()

    host = os.environ.get("COT_HOST", "127.0.0.1")
    port = int(os.environ.get("COT_PORT", "31337"))
    # The app's webview holds a keep-alive connection open, which would stall
    # shutdown until the app's SIGKILL fallback. Cap the wait so SIGTERM ends
    # with a clean lifespan shutdown.
    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level="info",
        access_log=False,
        timeout_graceful_shutdown=2,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
