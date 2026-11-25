"""HTTP-Schicht des lokalen Servers: Routen, Zugriffsschutz und statische Dateien.

Start:  uv run splattwin serve [port] [--lan]

Mit --lan ist der Server im lokalen Netz erreichbar, damit andere Geraete im WLAN zuschauen
koennen. Geraete im Netz bekommen dann nur die Zuschauerseite und was sie braucht; senden,
aufnehmen und kalibrieren geht weiterhin nur von diesem Rechner aus.

Dateien:  /runs/<lauf>/...  aus data/runs,  alles andere aus web/dist (npm run build in web/).
"""

import json
import posixpath
import re
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import cv2

from splattwin.contracts import ContractError
from splattwin.paths import RUNS, WEB_DIST
from splattwin.server import calibration
from splattwin.server.captures import save_capture
from splattwin.server.live import Live, parse_frame
from splattwin.server.network import lan_addresses

MAX_BODY = 20 * 1024 * 1024

# Was Geraete im Netz (nicht dieser Rechner) abrufen duerfen.
REMOTE_ALLOWED = re.compile(
    r"/(live\.html|logo\.svg|favicon\.ico|assets/[\w.-]+\.(js|css|wasm)|models/[\w.-]+\.glb"
    r"|runs/[\w-]+/(splat\.ply|splat\.json|rig\.json)|api/live|api/info)?"
)

NOT_BUILT = """<!doctype html><meta charset="utf-8"><title>Splattwin</title>
<body style="font:16px system-ui;margin:40px;background:#14161a;color:#e6e8ec">
<h1>Die Seiten sind noch nicht gebaut</h1>
<p>Im Projektordner einmal <code>make web</code> ausfuehren (oder <code>cd web && npm ci && npm run build</code>),
dann diese Seite neu laden.</p>
<p>Zum Entwickeln: <code>cd web && npm run dev</code> und die Adresse oeffnen, die Vite anzeigt.</p>"""

live = Live()


class Handler(SimpleHTTPRequestHandler):
    lan = False

    def is_local(self) -> bool:
        return self.client_address[0] in ("127.0.0.1", "::1", "::ffff:127.0.0.1")

    def translate_path(self, path: str) -> str:
        url = urlparse(path).path
        if url.startswith("/runs/"):
            rel = posixpath.normpath(unquote(url[len("/runs/") :]))
            if rel.startswith(("..", "/")):
                return str(RUNS / "__ungueltig__")
            return str(RUNS / rel)
        return super().translate_path(path)

    def do_GET(self):
        url = urlparse(self.path)
        if not self.is_local() and not REMOTE_ALLOWED.fullmatch(url.path):
            self.send_json(403, {"error": "nur auf diesem Rechner"})
            return
        if url.path == "/" and not self.is_local():  # Geraete im Netz landen direkt beim Zuschauen
            self.send_response(302)
            self.send_header("Location", "/live.html")
            self.end_headers()
            return
        if url.path == "/api/info":
            port = self.server.server_address[1]
            urls = [f"http://{a}:{port}/live.html" for a in lan_addresses()] if self.lan else []
            self.send_json(200, {"lan": self.lan, "urls": urls, "viewers": live.viewers})
            return
        if url.path == "/api/live":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()

            def write(data):
                self.wfile.write(data)
                self.wfile.flush()

            live.stream(write)
            return
        if not WEB_DIST.exists() and url.path in ("/", "/index.html"):
            self.send_html(200, NOT_BUILT)
            return
        super().do_GET()

    def do_HEAD(self):
        url = urlparse(self.path)
        if not self.is_local() and not REMOTE_ALLOWED.fullmatch(url.path):
            self.send_json(403, {"error": "nur auf diesem Rechner"})
            return
        if not WEB_DIST.exists() and url.path in ("/", "/index.html"):
            self.send_html(200, NOT_BUILT, body=False)
            return
        super().do_HEAD()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "/api/" not in str(args[0] if args else ""):
            super().log_message(fmt, *args)

    def send_json(self, status: int, payload) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_html(self, status: int, html: str, body: bool = True) -> None:
        data = html.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if body:
            self.wfile.write(data)

    def do_POST(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        if not self.is_local():
            self.send_json(403, {"error": "nur auf diesem Rechner"})
            return
        length = int(self.headers.get("Content-Length", 0))
        try:
            if url.path == "/api/live":
                self.send_json(200, {"viewers": live.publish(parse_frame(self.rfile.read(length)))})
            elif url.path == "/api/capture":
                self.send_json(200, save_capture(query, self.rfile, length))
            elif url.path in ("/api/chessboard", "/api/calibrate"):
                cam = query.get("cam", ["A"])[0]
                if cam not in ("A", "B"):
                    raise ValueError("unbekannte Kamera")
                if length > MAX_BODY:
                    raise ValueError("Bild zu gross")
                body = self.rfile.read(length)
                if url.path == "/api/chessboard":
                    self.send_json(200, calibration.add_view(cam, body, "reset" in query))
                else:
                    self.send_json(200, calibration.calibrate(cam))
            else:
                self.send_json(404, {"error": "unbekannter Pfad"})
        except (ValueError, ContractError, cv2.error) as err:
            self.send_json(400, {"error": str(err)})


def make_server(port: int, lan: bool, root: Path = WEB_DIST) -> ThreadingHTTPServer:
    Handler.lan = lan
    ThreadingHTTPServer.daemon_threads = True  # offene Zuschauer halten das Beenden nicht auf
    return ThreadingHTTPServer(("0.0.0.0" if lan else "127.0.0.1", port), partial(Handler, directory=str(root)))


def serve(port: int = 8931, lan: bool = False) -> None:
    server = make_server(port, lan)
    print(f"Live-Avatar laeuft auf http://127.0.0.1:{port}", flush=True)
    if not WEB_DIST.exists():
        print(f"Hinweis: {WEB_DIST} fehlt. Seiten bauen mit: make web", flush=True)
    for a in lan_addresses() if lan else []:
        print(f"Zuschauen im WLAN:  http://{a}:{port}/live.html", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
