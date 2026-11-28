"""HTTP-Schicht des lokalen Servers (FastAPI): Routen, Zugriffsschutz und statische Dateien.

Start:  uv run splattwin serve [port] [--lan] [--public]
API-Doku im Browser: http://127.0.0.1:8931/api/docs

Mit --lan ist der Server im lokalen Netz erreichbar. Wer darf was, steht in server/access.py:
dieser Rechner alles, Presenter nach dem Login ueber present.<Adresse> tracken und Folien umschalten,
alle anderen nur zuschauen (Buehne). --public: hinter einem Tunnel mit HTTPS (Cookie nur ueber HTTPS).

Dateien:  /runs/<lauf>/...  aus data/runs,  /stage/slides.pdf  aus data/stage,  alles andere aus
web/dist (npm run build in web/).
"""

import asyncio
import json
import logging
import os
import re
import secrets
import time
from pathlib import Path
from typing import Literal

import cv2
from fastapi import FastAPI, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import Headers
from starlette.exceptions import HTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from splattwin.contracts import ContractError
from splattwin.paths import RUNS, STAGE, WEB_DIST
from splattwin.server import access, calibration, captures
from splattwin.server.network import lan_addresses
from splattwin.server.stage import SLOTS, Stage, frame_ok, save_skin, skin_current

MAX_BODY = 20 * 1024 * 1024

# Was Zuschauer (nicht dieser Rechner, nicht eingeloggt) abrufen duerfen, nur mit GET oder HEAD.
REMOTE_ALLOWED = re.compile(
    r"/(live\.html|logo\.svg|favicon\.ico|assets/[\w.-]+\.(js|css|wasm|mjs)|models/[\w.-]+\.glb"
    r"|runs/[\w-]+/(splat\.ply|splat\.json|rig\.json|skin\.bin|smplx\.json|smplx_skin\.bin)|stage/slides\.pdf|ws/stage|api/info)?"
)
# Was eingeloggte Presenter nicht duerfen (Aufnahmen speichern bleibt bei diesem Rechner).
PRESENTER_BLOCKED = re.compile(r"/api/capture")
# Nur auf der Presenter-Adresse, auch ohne Login.
LOGIN_PATHS = ("/login.html", "/api/login", "/api/logout")


def cache_control(path: str, query: bytes) -> bytes:
    """Grosse, unveraenderliche Dateien lange behalten (ein Tunnel wie Cloudflare liefert sie dann aus
    seinem Cache statt von diesem Rechner), Seiten und Laeufe jedes Mal kurz nachfragen (304, wenn
    unveraendert), Live-Daten und API nie."""
    if path.startswith(("/api/", "/ws/")):
        return b"no-store"
    if path.startswith("/assets/"):
        return b"public, max-age=31536000, immutable"  # Vite haengt einen Hash an den Namen
    if path.endswith((".glb", ".png", ".jpg", ".task")) or (path == "/stage/slides.pdf" and b"v=" in query):
        return b"public, max-age=86400"
    return b"no-cache"


NOT_BUILT = """<!doctype html><meta charset="utf-8"><title>Splattwin</title>
<body style="font:16px system-ui;margin:40px;background:#14161a;color:#e6e8ec">
<h1>Die Seiten sind noch nicht gebaut</h1>
<p>Im Projektordner einmal <code>make web</code> ausfuehren (oder <code>cd web && npm ci && npm run build</code>),
dann diese Seite neu laden.</p>
<p>Zum Entwickeln: <code>make dev</code> und die Adresse oeffnen, die Vite anzeigt.</p>"""


class Guard:
    """Zugriffsschutz und Cache-Regeln als ASGI-Schicht, fuer HTTP und WebSockets.

    Legt in scope["state"]["presenter"] ab, wer sendet: "local" (dieser Rechner), "A"/"B"
    (eingeloggt) oder None (Zuschauer)."""

    def __init__(self, app: ASGIApp, sessions: access.Sessions):
        self.app = app
        self.sessions = sessions

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        path = scope["path"]
        presenter = "local" if access.is_local(scope.get("client"), headers) else self.sessions.slot(headers)
        scope.setdefault("state", {})["presenter"] = presenter
        method = scope.get("method", "GET")

        if presenter == "local":
            allowed = True
        elif presenter:
            allowed = not PRESENTER_BLOCKED.match(path)
        else:
            allowed = (method in ("GET", "HEAD") and bool(REMOTE_ALLOWED.fullmatch(path))) or (
                access.is_presenter_host(headers) and path in LOGIN_PATHS
            )

        if scope["type"] == "websocket":
            if not allowed:
                await send({"type": "websocket.close", "code": 1008})  # vor dem Annehmen: Abweisen
                return
            await self.app(scope, receive, send)
            return

        if path == "/" and presenter != "local":
            if access.is_presenter_host(headers):
                target = "/tracking.html" if presenter else "/login.html"
            else:
                target = "/live.html"  # Zuschauer landen direkt auf der Buehne
            await RedirectResponse(target, status_code=302)(scope, receive, send)
            return
        if not allowed:
            if access.is_presenter_host(headers) and path.endswith(".html"):
                await RedirectResponse("/login.html", status_code=302)(scope, receive, send)
            else:
                await JSONResponse({"error": "nur fuer Presenter"}, status_code=403)(scope, receive, send)
            return

        cache = cache_control(path, scope.get("query_string", b""))

        async def with_cache(message: Message) -> None:
            if message["type"] == "http.response.start":
                message.setdefault("headers", []).append((b"cache-control", cache))
            await send(message)

        await self.app(scope, receive, with_cache)


def create_app(
    lan: bool = False,
    web_dist: Path = WEB_DIST,
    runs: Path = RUNS,
    stage_dir: Path = STAGE,
    passwords: dict[str, str] | None = None,
    public: bool = False,
) -> FastAPI:
    app = FastAPI(
        title="Splattwin",
        summary="Lokaler Server: Seiten, Kalibrierung, Aufnahmen, Buehne",
        docs_url="/api/docs",
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )
    stage = Stage(stage_dir)
    sessions = access.Sessions(passwords or {})
    app.state.stage = stage

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

    def presenter(request: Request | WebSocket) -> str | None:
        return request.scope.get("state", {}).get("presenter")

    # ------------------------------------------------------------------ Login
    @app.post("/api/login", summary="Presenter-Login fuer Platz A oder B (nur ueber present.<Adresse>)")
    async def login(request: Request) -> JSONResponse:
        if not access.is_presenter_host(request.headers):
            raise ValueError("Login nur ueber die Presenter-Adresse")
        data = json.loads(await read_limited(request, 4096) or b"{}")
        token = sessions.login(str(data.get("slot", "")), str(data.get("password", "")))
        if not token:
            await asyncio.sleep(1)  # Raten bremsen
            return JSONResponse({"error": "Platz oder Passwort falsch"}, status_code=401)
        secure = public or request.headers.get("x-forwarded-proto") == "https"
        res = JSONResponse({"slot": data["slot"]})
        res.headers["set-cookie"] = access.cookie_header(token, secure)
        return res

    @app.post("/api/logout", summary="Presenter abmelden")
    async def logout(request: Request) -> JSONResponse:
        sessions.logout(access.token(request.headers))
        res = JSONResponse({})
        res.headers["set-cookie"] = access.cookie_header("", False, max_age=0)
        return res

    # ------------------------------------------------------------------ Buehne
    @app.get("/api/info", summary="Adressen im WLAN, Anzahl Zuschauer, eigener Platz")
    async def info(request: Request) -> dict:
        port = request.url.port or 80
        who = presenter(request)
        result = {
            "lan": lan,
            "urls": [f"http://{a}:{port}/live.html" for a in lan_addresses()] if lan else [],
            "viewers": stage.viewers,
            "presenter": who is not None,
            "slot": who if who in SLOTS else None,
        }
        if who == "local":
            result["presenterUrl"] = f"http://{access.PRESENTER_PREFIX}localhost:{port}/"
        return result

    @app.websocket("/ws/stage")
    async def stage_viewer(ws: WebSocket) -> None:
        """Buehne und Regie: Folien und Platz-Infos als Text, Bilder binaer mit dem Platz davor."""
        await ws.accept()

        async def reader() -> None:  # nur um ein Schliessen sofort zu bemerken
            try:
                while (await ws.receive())["type"] != "websocket.disconnect":
                    pass
            except (WebSocketDisconnect, RuntimeError):
                pass

        task = asyncio.create_task(reader())
        task.add_done_callback(lambda _: stage.wake())
        try:
            async for key, data in stage.stream(lambda: not task.done()):
                if key == "slides":
                    await ws.send_text('{"type":"slides","state":' + data.decode() + "}")
                elif key.startswith("meta:"):
                    await ws.send_text('{"type":"meta","slot":"' + key[5:] + '","meta":' + data.decode() + "}")
                else:
                    await ws.send_bytes(bytes([SLOTS.index(key)]) + data)
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            task.cancel()

    @app.websocket("/ws/send")
    async def stage_sender(ws: WebSocket, slot: str = "A") -> None:
        """Tracking-Seite: Bilder binaer (web/src/live/protocol.ts), Name und Lauf als Text
        (contracts/stage-meta). Eingeloggte senden immer auf ihrem Platz, nur dieser Rechner waehlt."""
        who = presenter(ws)
        seat = who if who in SLOTS else slot
        if not who or seat not in SLOTS:
            await ws.close(code=1008)
            return
        await ws.accept()
        await ws.send_json({"type": "hello", "slot": seat})
        last_info = 0.0
        try:
            while True:
                msg = await ws.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                if msg.get("bytes") is not None:
                    if frame_ok(msg["bytes"]):
                        stage.publish(seat, msg["bytes"])
                elif msg.get("text"):
                    try:
                        stage.set_meta(seat, json.loads(msg["text"]))
                    except (ValueError, ContractError):
                        pass
                if time.monotonic() - last_info > 1:
                    last_info = time.monotonic()
                    await ws.send_json({"type": "info", "viewers": stage.viewers})
        except (WebSocketDisconnect, RuntimeError):
            pass

    @app.post("/api/slides", summary="Folien als PDF hochladen (contracts/stage-slides)")
    async def upload_slides(request: Request, name: str = "Folien") -> dict:
        return stage.save_pdf(await read_limited(request, 200 * 1024 * 1024), name)

    @app.post("/api/slide", summary="Folie umschalten oder Anzahl melden: {page} oder {pages}")
    async def set_slide(request: Request) -> dict:
        change = json.loads(await read_limited(request, 4096) or b"{}")
        return stage.set_slides(**{k: int(v) for k, v in change.items() if k in ("page", "pages")})

    @app.post("/api/skin", summary="Vorgerechneten Splat speichern (data/runs/<lauf>/skin.bin)")
    async def upload_skin(request: Request, run: str) -> dict:
        return save_skin(runs, run, await read_limited(request, 64 * 1024 * 1024))

    @app.get("/runs/{run}/skin.bin", include_in_schema=False)
    async def skin(run: str, request: Request):
        # Veraltet (Splat neu gerechnet) = gibt es nicht: die Seite rechnet neu und laedt hoch.
        if not skin_current(runs, run):
            return JSONResponse({"error": "noch nicht vorgerechnet"}, status_code=404)
        return await runs_files.get_response(f"{run}/skin.bin", request.scope)

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
    @app.get("/stage/slides.pdf", include_in_schema=False)
    async def slides_pdf(request: Request):
        if not stage.pdf.exists():
            return JSONResponse({"error": "keine Folien"}, status_code=404)
        return await stage_files.get_response("slides.pdf", request.scope)

    runs_files = StaticFiles(directory=runs, check_dir=False)
    stage_files = StaticFiles(directory=stage_dir, check_dir=False)
    app.mount("/runs", runs_files, name="runs")
    if not web_dist.exists():

        @app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
        @app.api_route("/index.html", methods=["GET", "HEAD"], include_in_schema=False)
        async def not_built() -> HTMLResponse:
            return HTMLResponse(NOT_BUILT)

    app.mount("/", StaticFiles(directory=web_dist, html=True, check_dir=False), name="web")
    app.add_middleware(Guard, sessions=sessions)
    return app


async def read_limited(request: Request, limit: int) -> bytes:
    data = bytearray()
    async for chunk in request.stream():
        data += chunk
        if len(data) > limit:
            raise ValueError("Datei zu gross")
    return bytes(data)


class _QuietApi(logging.Filter):
    """Anfragen an /api/ und /ws/ nicht ins Protokoll schreiben."""

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        return "/api/" not in message and "/ws/" not in message


def presenter_passwords() -> dict[str, str]:
    """Aus SPLATTWIN_PW_A und SPLATTWIN_PW_B, sonst zufaellig (beim Start angezeigt)."""
    return {slot: os.environ.get(f"SPLATTWIN_PW_{slot}") or secrets.token_urlsafe(6) for slot in SLOTS}


def serve(port: int = 8931, lan: bool = False, public: bool = False) -> None:
    import uvicorn

    passwords = presenter_passwords()
    print(f"Live-Avatar laeuft auf http://127.0.0.1:{port}", flush=True)
    print(f"Buehne:             http://127.0.0.1:{port}/live.html", flush=True)
    print(f"Presenter-Login:    http://{access.PRESENTER_PREFIX}localhost:{port}/  (oder present.<eure Adresse>)")
    for slot in SLOTS:
        shown = f"aus SPLATTWIN_PW_{slot}" if os.environ.get(f"SPLATTWIN_PW_{slot}") else passwords[slot]
        print(f"  Passwort Platz {slot}: {shown}", flush=True)
    if not WEB_DIST.exists():
        print(f"Hinweis: {WEB_DIST} fehlt. Seiten bauen mit: make web", flush=True)
    for a in lan_addresses() if lan else []:
        print(f"Buehne im WLAN:     http://{a}:{port}/live.html", flush=True)
    logging.getLogger("uvicorn.access").addFilter(_QuietApi())
    app = create_app(lan, passwords=passwords, public=public)

    class Server(uvicorn.Server):
        def handle_exit(self, sig, frame):
            # Zuerst die Zuschauer abmelden: ihre Streams enden, die Verbindungen schliessen sich, und
            # uvicorn muss beim Herunterfahren nichts abbrechen.
            asyncio.get_event_loop().call_soon_threadsafe(app.state.stage.close)
            super().handle_exit(sig, frame)

    config = uvicorn.Config(app, host="0.0.0.0" if lan else "127.0.0.1", port=port, timeout_graceful_shutdown=3)
    try:
        Server(config).run()
    except KeyboardInterrupt:
        pass  # uvicorn gibt Ctrl+C nach dem sauberen Herunterfahren weiter
