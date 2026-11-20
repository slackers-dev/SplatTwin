#!/usr/bin/env python3
"""Lokaler Server fuer den Live-Avatar.

Liefert die Seite aus und kalibriert Kameras mit OpenCV (3DRecon 1):
Die Seite schickt Einzelbilder eines Schachbretts, der Server sucht die Ecken
und berechnet daraus Kameramatrix und Linsenverzeichnung.

Leitet ausserdem das Live-Tracking weiter: Die Tracking-Seite (index.html) schickt pro Bild
die Gelenkpunkte an /api/live, Zuschauerseiten (live.html) empfangen sie als Server-Sent Events.

Start:  .venv/bin/python server.py [port] [--lan]

Mit --lan ist der Server im lokalen Netz erreichbar, damit andere Geraete im WLAN zuschauen
koennen. Geraete im Netz bekommen dann nur die Zuschauerseite und was sie braucht; senden,
aufnehmen und kalibrieren geht weiterhin nur von diesem Rechner aus.
"""

import json
import re
import socket
import subprocess
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent
PATTERN = (9, 6)        # innere Ecken des Schachbretts (10 x 7 Felder)
MIN_VIEWS = 8           # so viele Ansichten braucht calibrateCamera mindestens
MIN_SHIFT = 0.02        # neue Ansicht muss sich um 2 % der Bildbreite unterscheiden
MAX_BODY = 20 * 1024 * 1024

CAPTURES = ROOT / "splat" / "captures"   # Aufnahmen der Seite capture.html

LIVE_PING = 15          # Sekunden: so oft bekommt ein Zuschauer ohne neue Daten ein Lebenszeichen
LIVE_STALE = 2          # Sekunden: so lange ohne Bild gilt der Tracker als weg

# Was Geraete im Netz (nicht dieser Rechner) abrufen duerfen.
REMOTE_ALLOWED = re.compile(
    r"/(live\.html|live\.js|retarget\.js|splat-avatar\.js|favicon\.ico|models/[\w.-]+\.glb"
    r"|splat/runs/[\w-]+/(splat\.ply|splat\.json|rig\.json)|api/live|api/info)?")

sessions = {}           # Kamera -> {"size": (w, h), "views": [Ecken, ...]}
lock = threading.Lock()


def find_corners(gray):
    """Sucht das Schachbrett, Rueckgabe: Ecken (N, 1, 2) oder None."""
    found, corners = cv2.findChessboardCornersSB(
        gray, PATTERN, flags=cv2.CALIB_CB_NORMALIZE_IMAGE | cv2.CALIB_CB_ACCURACY)
    if found:
        return corners.astype(np.float32)
    found, corners = cv2.findChessboardCorners(
        gray, PATTERN, flags=cv2.CALIB_CB_ADAPTIVE_THRESH | cv2.CALIB_CB_NORMALIZE_IMAGE)
    if not found:
        return None
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.001)
    return cv2.cornerSubPix(gray, corners, (11, 11), (-1, -1), criteria)


def add_view(cam, jpeg, reset):
    image = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise ValueError("Bild konnte nicht gelesen werden")
    h, w = image.shape
    corners = find_corners(image)

    with lock:
        session = sessions.get(cam)
        if reset or session is None or session["size"] != (w, h):
            session = sessions[cam] = {"size": (w, h), "views": []}
        result = {"found": corners is not None, "accepted": False, "count": len(session["views"])}
        if corners is None:
            return result
        # Fast identische Ansichten bringen nichts: erst uebernehmen, wenn sich das Brett bewegt hat.
        if session["views"]:
            shift = np.abs(session["views"][-1] - corners).mean() / w
            if shift < MIN_SHIFT:
                return result
        session["views"].append(corners)
        result.update(accepted=True, count=len(session["views"]),
                      corners=(corners.reshape(-1, 2) / [w, h]).round(4).tolist())
        return result


def calibrate(cam):
    with lock:
        session = sessions.get(cam)
        views = list(session["views"]) if session else []
        size = session["size"] if session else None
    if len(views) < MIN_VIEWS:
        raise ValueError(f"Nur {len(views)} brauchbare Ansichten, mindestens {MIN_VIEWS} noetig")

    # Die Feldgroesse spielt fuer Brennweite und Verzeichnung keine Rolle: Einheit = 1 Feld.
    grid = np.zeros((PATTERN[0] * PATTERN[1], 3), np.float32)
    grid[:, :2] = np.mgrid[0:PATTERN[0], 0:PATTERN[1]].T.reshape(-1, 2)
    rms, K, dist, _, _ = cv2.calibrateCamera([grid] * len(views), views, size, None, None)

    w, h = size
    fx, fy, cx, cy = K[0, 0], K[1, 1], K[0, 2], K[1, 2]
    return {
        # Bezogen auf Bildbreite bzw. -hoehe, damit die Werte auch bei anderer Aufloesung gelten.
        "fx": fx / w, "fy": fy / h, "cx": cx / w, "cy": cy / h,
        "dist": [float(v) for v in dist.ravel()[:5]],
        "rms": float(rms), "width": w, "height": h, "views": len(views),
        "fovY": float(np.degrees(2 * np.arctan(h / (2 * fy)))),
        "fovX": float(np.degrees(2 * np.arctan(w / (2 * fx)))),
    }


def save_capture(query, stream, length):
    """Speichert eine Aufnahme aus dem Browser und wandelt sie in ein MP4 mit festen
    30 Bildern pro Sekunde um (die Rohdatei des Browsers hat unregelmaessige Zeitstempel)."""
    name = query.get("name", [""])[0]
    cam = query.get("cam", [""])[0]
    kind = query.get("kind", ["webm"])[0]
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", name) or cam not in ("a", "b") or kind not in ("webm", "mp4", "json"):
        raise ValueError("ungueltige Angaben zur Aufnahme")
    CAPTURES.mkdir(parents=True, exist_ok=True)
    if kind == "json":
        (CAPTURES / f"{name}.json").write_bytes(stream.read(length))
        return {"saved": f"{name}.json"}
    raw = CAPTURES / f"{name}_{cam}.roh.{kind}"
    with open(raw, "wb") as out:
        left = length
        while left > 0:
            chunk = stream.read(min(left, 1 << 20))
            if not chunk:
                break
            out.write(chunk)
            left -= len(chunk)
    final = CAPTURES / f"{name}_{cam}.mp4"
    # Hochkant stehendes Handy: das Bild kommt liegend an und wird hier aufgerichtet.
    turn = {"90": ["-vf", "transpose=1"], "270": ["-vf", "transpose=2"]}.get(query.get("rot", ["0"])[0], [])
    done = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(raw), *turn, "-r", "30", "-c:v", "libx264",
                           "-crf", "15", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an", str(final)],
                          capture_output=True, text=True)
    if done.returncode != 0:
        raise ValueError("Umwandlung fehlgeschlagen: " + done.stderr.strip()[-300:])
    cap = cv2.VideoCapture(str(final))
    info = {"saved": final.name, "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
            "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
            "seconds": round(cap.get(cv2.CAP_PROP_FRAME_COUNT) / 30, 2)}
    cap.release()
    return info


class Live:
    """Letztes Bild des Trackers; Zuschauer warten auf das naechste (aeltere werden verworfen,
    ein langsamer Zuschauer bekommt also nur weniger Bilder statt einer wachsenden Verzoegerung)."""

    def __init__(self):
        self.cond = threading.Condition()
        self.seq = 0
        self.frame = b""
        self.time = 0.0
        self.viewers = 0

    def publish(self, frame):
        with self.cond:
            self.seq += 1
            self.frame = frame
            self.time = time.monotonic()
            self.cond.notify_all()
            return self.viewers

    def stream(self, write):
        with self.cond:
            self.viewers += 1
            seen = self.seq if time.monotonic() - self.time > LIVE_STALE else self.seq - 1
        try:
            while True:
                with self.cond:
                    self.cond.wait_for(lambda: self.seq != seen, timeout=LIVE_PING)
                    seq, frame = self.seq, self.frame
                if seq == seen:
                    write(b": ping\n\n")
                    continue
                seen = seq
                write(b"data: " + frame + b"\n\n")
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with self.cond:
                self.viewers -= 1


live = Live()


def lan_addresses():
    """IP-Adressen dieses Rechners im lokalen Netz (ohne Verbindung nach aussen zu oeffnen)."""
    found = set()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))  # UDP: es wird nichts gesendet
            found.add(s.getsockname()[0])
    except OSError:
        pass
    return sorted(a for a in found if not a.startswith("127."))


class Handler(SimpleHTTPRequestHandler):
    lan = False

    def is_local(self):
        return self.client_address[0] in ("127.0.0.1", "::1", "::ffff:127.0.0.1")

    def do_GET(self):
        url = urlparse(self.path)
        if not self.is_local() and not REMOTE_ALLOWED.fullmatch(url.path):
            self.send_json(403, {"error": "nur auf diesem Rechner"})
            return
        if url.path == "/":
            if not self.is_local():  # Geraete im Netz landen direkt beim Zuschauen
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
        super().do_GET()

    def do_HEAD(self):
        if not self.is_local() and not REMOTE_ALLOWED.fullmatch(urlparse(self.path).path):
            self.send_json(403, {"error": "nur auf diesem Rechner"})
            return
        super().do_HEAD()


    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "/api/" not in str(args[0] if args else ""):
            super().log_message(fmt, *args)

    def send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        cam = query.get("cam", ["A"])[0]
        if not self.is_local():
            self.send_json(403, {"error": "nur auf diesem Rechner"})
            return
        try:
            if url.path == "/api/live":
                length = int(self.headers.get("Content-Length", 0))
                if length > 64 * 1024:
                    raise ValueError("Bild des Trackers zu gross")
                frame = self.rfile.read(length).replace(b"\n", b"")
                self.send_json(200, {"viewers": live.publish(frame)})
                return
            if url.path == "/api/capture":
                length = int(self.headers.get("Content-Length", 0))
                self.send_json(200, save_capture(query, self.rfile, length))
                return
            if cam not in ("A", "B"):
                raise ValueError("unbekannte Kamera")
            length = int(self.headers.get("Content-Length", 0))
            if length > MAX_BODY:
                raise ValueError("Bild zu gross")
            body = self.rfile.read(length)
            if url.path == "/api/chessboard":
                self.send_json(200, add_view(cam, body, "reset" in query))
            elif url.path == "/api/calibrate":
                self.send_json(200, calibrate(cam))
            else:
                self.send_json(404, {"error": "unbekannter Pfad"})
        except (ValueError, cv2.error) as err:
            self.send_json(400, {"error": str(err)})


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    port = int(args[0]) if args else 8931
    Handler.lan = "--lan" in sys.argv
    ThreadingHTTPServer.daemon_threads = True  # offene Zuschauer halten das Beenden nicht auf
    server = ThreadingHTTPServer(("0.0.0.0" if Handler.lan else "127.0.0.1", port),
                                 partial(Handler, directory=str(ROOT)))
    print(f"Live-Avatar laeuft auf http://127.0.0.1:{port}", flush=True)
    for a in lan_addresses() if Handler.lan else []:
        print(f"Zuschauen im WLAN:  http://{a}:{port}/live.html", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
