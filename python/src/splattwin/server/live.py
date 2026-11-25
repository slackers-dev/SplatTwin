"""Live-Tracking an Zuschauer weiterleiten: die Tracking-Seite schickt pro Bild die Gelenkpunkte
(POST /api/live), Zuschauerseiten empfangen sie als Server-Sent Events (GET /api/live)."""

import json
import threading
import time
from collections.abc import Callable

from splattwin import contracts

PING_SECONDS = 15  # so oft bekommt ein Zuschauer ohne neue Daten ein Lebenszeichen
STALE_SECONDS = 2  # so lange ohne Bild gilt der Tracker als weg
MAX_FRAME = 64 * 1024


def parse_frame(body: bytes) -> bytes:
    """Prueft ein Bild des Trackers und liefert es als eine Zeile (fuer Server-Sent Events)."""
    if len(body) > MAX_FRAME:
        raise ValueError("Bild des Trackers zu gross")
    contracts.validate("live-frame", json.loads(body))
    return body.replace(b"\n", b"")


class Live:
    """Letztes Bild des Trackers; Zuschauer warten auf das naechste (aeltere werden verworfen,
    ein langsamer Zuschauer bekommt also nur weniger Bilder statt einer wachsenden Verzoegerung)."""

    def __init__(self):
        self.cond = threading.Condition()
        self.seq = 0
        self.frame = b""
        self.time = 0.0
        self.viewers = 0

    def publish(self, frame: bytes) -> int:
        with self.cond:
            self.seq += 1
            self.frame = frame
            self.time = time.monotonic()
            self.cond.notify_all()
            return self.viewers

    def stream(self, write: Callable[[bytes], None]) -> None:
        with self.cond:
            self.viewers += 1
            seen = self.seq if time.monotonic() - self.time > STALE_SECONDS else self.seq - 1
        try:
            while True:
                with self.cond:
                    self.cond.wait_for(lambda last=seen: self.seq != last, timeout=PING_SECONDS)
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
