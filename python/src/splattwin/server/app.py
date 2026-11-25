"""HTTP-Schicht des lokalen Servers (FastAPI): Routen, Zugriffsschutz und statische Dateien.

Start:  uv run splattwin serve [port] [--lan]
API-Doku im Browser: http://127.0.0.1:8931/api/docs

Mit --lan ist der Server im lokalen Netz erreichbar, damit andere Geraete im WLAN zuschauen
koennen. Geraete im Netz bekommen dann nur die Zuschauerseite und was sie braucht; senden,
aufnehmen und kalibrieren geht weiterhin nur von diesem Rechner aus.

Dateien:  /runs/<lauf>/...  aus data/runs,  alles andere aus web/dist (npm run build in web/).
"""

import asyncio
import logging
import re
from pathlib import Path
from typing import Literal

import cv2
from fastapi import FastAPI, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from splattwin.contracts import ContractError
from splattwin.paths import RUNS, WEB_DIST
from splattwin.server import calibration, captures
from splattwin.server.live import Live, parse_frame
from splattwin.server.network import lan_addresses

MAX_BODY = 20 * 1024 * 1024
LOCAL_HOSTS = ("127.0.0.1", "::1", "::ffff:127.0.0.1")

# Was Geraete im Netz (nicht dieser Rechner) abrufen duerfen, nur mit GET oder HEAD.
REMOTE_ALLOWED = re.compile(
    r"/(live\.html|logo\.svg|favicon\.ico|assets/[\w.-]+\.(js|css|wasm)|models/[\w.-]+\.glb"
    r"|runs/[\w-]+/(splat\.ply|splat\.json|rig\.json)|api/live|api/info)?"
)

NOT_BUILT = """<!doctype html><meta charset="utf-8"><title>Splattwin</title>
<body style="font:16px system-ui;margin:40px;background:#14161a;color:#e6e8ec">
<h1>Die Seiten sind noch nicht gebaut</h1>
<p>Im Projektordner einmal <code>make web</code> ausfuehren (oder <code>cd web && npm ci && npm run build</code>),
dann diese Seite neu laden.</p>
<p>Zum Entwickeln: <code>make dev</code> und die Adresse oeffnen, die Vite anzeigt.</p>"""


class Guard:
    """Zugriffsschutz und Cache-Verbot als ASGI-Schicht (laesst Server-Sent Events unangetastet).

    Dieser Rechner darf alles. Geraete im Netz nur, was REMOTE_ALLOWED erlaubt, und nur lesen;
    die Startseite fuehrt sie direkt zum Zuschauen."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        client = scope.get("client")
        if not (client and client[0] in LOCAL_HOSTS):
            path, method = scope["path"], scope["method"]
            if method not in ("GET", "HEAD") or not REMOTE_ALLOWED.fullmatch(path):
                await JSONResponse({"error": "nur auf diesem Rechner"}, status_code=403)(scope, receive, send)
                return
            if path == "/":
                await RedirectResponse("/live.html", status_code=302)(scope, receive, send)
                return

        async def no_store(message: Message) -> None:
            if message["type"] == "http.response.start":
                message.setdefault("headers", []).append((b"cache-control", b"no-store"))
            await send(message)

        await self.app(scope, receive, no_store)


def create_app(lan: bool = False, web_dist: Path = WEB_DIST, runs: Path = RUNS) -> FastAPI:
    app = FastAPI(
        title="Splattwin",
        summary="Lokaler Server: Seiten, Kalibrierung, Aufnahmen, Live-Weiterleitung",
        docs_url="/api/docs",
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )
    live = Live()
    app.state.live = live

    @app.exception_handler(ValueError)
    @app.exception_handler(ContractError)
    @app.exception_handler(cv2.error)
    async def bad_request(_request: Request, err: Exception) -> JSONResponse:
        return JSONResponse({"error": str(err)}, status_code=400)

    @app.exception_handler(RequestValidationError)
    async def invalid(_request: Request, err: RequestValidationError) -> JSONResponse:
        first = err.errors()[0]
        where = ".".join(str(p) for p in first.get("loc", ()))
        return JSONResponse({"error": f"{where}: {first.get('msg', 'ungueltig')}"}, status_code=400)

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, err: HTTPException) -> JSONResponse:
        # Die Seiten erwarten Fehler als {"error": ...}.
        detail = "unbekannter Pfad" if err.status_code == 404 and request.url.path.startswith("/api/") else err.detail
        return JSONResponse({"error": detail}, status_code=err.status_code, headers=err.headers)

    # ------------------------------------------------------------------ Live
    @app.get("/api/info", summary="Adressen im WLAN und Anzahl Zuschauer")
    async def info(request: Request) -> dict:
        port = request.url.port or 80
        urls = [f"http://{a}:{port}/live.html" for a in lan_addresses()] if lan else []
        return {"lan": lan, "urls": urls, "viewers": live.viewers}

    @app.post("/api/live", summary="Ein Bild der Tracking-Seite an alle Zuschauer (contracts/live-frame)")
    async def publish(request: Request) -> dict:
        return {"viewers": live.publish(parse_frame(await request.body()))}

    @app.get("/api/live", summary="Bilder der Tracking-Seite als Server-Sent Events")
    async def stream() -> StreamingResponse:
        return StreamingResponse(live.stream(), media_type="text/event-stream")

    # ------------------------------------------------------------------ Kalibrierung
    @app.post("/api/chessboard", summary="Ein Bild des Schachbretts (JPEG) fuer die Kalibrierung")
    async def chessboard(request: Request, cam: Literal["A", "B"] = "A", reset: str | None = None) -> dict:
        body = await read_limited(request, MAX_BODY)
        return await run_in_threadpool(calibration.add_view, cam, body, reset is not None)

    @app.post("/api/calibrate", summary="Kameradaten aus den gesammelten Bildern (contracts/intrinsics)")
    async def calibrate(cam: Literal["A", "B"] = "A") -> dict:
        return await run_in_threadpool(calibration.calibrate, cam)

    # ------------------------------------------------------------------ Aufnahmen
    @app.post("/api/capture", summary="Aufnahme speichern: Video (wird nach MP4 umgewandelt) oder Metadatei")
    async def capture(
        request: Request,
        name: str = "",
        cam: str = "",
        kind: str = "webm",
        rot: str = Query("0", description="Grad, um die das Video aufgerichtet wird: 0, 90, 270"),
    ) -> dict:
        captures.check(name, cam, kind)
        if kind == "json":
            return captures.save_meta(name, await request.body())
        raw = captures.raw_path(name, cam, kind)
        with open(raw, "wb") as out:
            async for chunk in request.stream():
                out.write(chunk)
        return await run_in_threadpool(captures.convert, name, cam, raw, rot)

    @app.api_route("/api/{rest:path}", methods=["GET", "POST", "PUT", "DELETE"], include_in_schema=False)
    async def unknown(rest: str) -> JSONResponse:
        # Sonst landeten unbekannte API-Pfade bei den statischen Dateien (405 statt 404).
        return JSONResponse({"error": "unbekannter Pfad"}, status_code=404)

    # ------------------------------------------------------------------ Dateien
    app.mount("/runs", StaticFiles(directory=runs, check_dir=False), name="runs")
    if not web_dist.exists():

        @app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
        @app.api_route("/index.html", methods=["GET", "HEAD"], include_in_schema=False)
        async def not_built() -> HTMLResponse:
            return HTMLResponse(NOT_BUILT)

    app.mount("/", StaticFiles(directory=web_dist, html=True, check_dir=False), name="web")
    app.add_middleware(Guard)
    return app


async def read_limited(request: Request, limit: int) -> bytes:
    data = bytearray()
    async for chunk in request.stream():
        data += chunk
        if len(data) > limit:
            raise ValueError("Bild zu gross")
    return bytes(data)


class _QuietApi(logging.Filter):
    """Anfragen an /api/ (pro Bild eine) nicht ins Protokoll schreiben."""

    def filter(self, record: logging.LogRecord) -> bool:
        return "/api/" not in record.getMessage()


def serve(port: int = 8931, lan: bool = False) -> None:
    import uvicorn

    print(f"Live-Avatar laeuft auf http://127.0.0.1:{port}", flush=True)
    if not WEB_DIST.exists():
        print(f"Hinweis: {WEB_DIST} fehlt. Seiten bauen mit: make web", flush=True)
    for a in lan_addresses() if lan else []:
        print(f"Zuschauen im WLAN:  http://{a}:{port}/live.html", flush=True)
    logging.getLogger("uvicorn.access").addFilter(_QuietApi())
    app = create_app(lan)

    class Server(uvicorn.Server):
        def handle_exit(self, sig, frame):
            # Zuerst die Zuschauer abmelden: ihre Streams enden, die Verbindungen schliessen sich, und
            # uvicorn muss beim Herunterfahren nichts abbrechen.
            asyncio.get_event_loop().call_soon_threadsafe(app.state.live.close)
            super().handle_exit(sig, frame)

    config = uvicorn.Config(app, host="0.0.0.0" if lan else "127.0.0.1", port=port, timeout_graceful_shutdown=3)
    try:
        Server(config).run()
    except KeyboardInterrupt:
        pass  # uvicorn gibt Ctrl+C nach dem sauberen Herunterfahren weiter
