# PyInstaller spec for the collector binary embedded in cot.app.
# Built from macos/build.sh; `pathex` points at backend/ so `app.main` resolves.

import os

REPO = os.environ["COT_REPO_ROOT"]

a = Analysis(
    [os.path.join(REPO, "macos", "packaging", "collector_entry.py")],
    pathex=[os.path.join(REPO, "backend")],
    binaries=[],
    datas=[
        (os.path.join(REPO, "backend", "app", "pricing.json"), "app"),
        # Served by GET /install.sh and GET /cot. main.py resolves these two
        # directories up from app/main.py, which lands on _internal/bridge here.
        (os.path.join(REPO, "bridge", "install.sh"), "bridge"),
        (os.path.join(REPO, "bridge", "cot"), "bridge"),
    ],
    hiddenimports=[
        "uvicorn.logging",
        "uvicorn.loops.auto",
        "uvicorn.loops.asyncio",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.http.h11_impl",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan.on",
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "test", "unittest"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="cot-collector",
    debug=False,
    strip=False,
    upx=False,
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="cot-collector",
)
