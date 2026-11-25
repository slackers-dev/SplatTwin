"""Live-Tracking an Zuschauer weiterleiten: die Tracking-Seite schickt pro Bild die Gelenkpunkte
(POST /api/live), Zuschauerseiten empfangen sie als Server-Sent Events (GET /api/live)."""

import asyncio
import json
import time
from collections.abc import AsyncIterator

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
    ein langsamer Zuschauer bekommt also nur weniger Bilder statt einer wachsenden Verzoegerung).

    Jedes neue Bild setzt das aktuelle Event und legt ein frisches an: alle Zuschauer, die darauf
    warten, wachen auf. close() beendet alle Streams, damit der Server ohne Abbruch herunterfaehrt."""

    def __init__(self):
        self.seq = 0
        self.frame = b""
        self.time = 0.0
        self.viewers = 0
        self.closed = False
        self._changed = asyncio.Event()

    def _wake(self) -> None:
        self._changed.set()
        self._changed = asyncio.Event()

    def publish(self, frame: bytes) -> int:
        self.seq += 1
        self.frame = frame
        self.time = time.monotonic()
        self._wake()
        return self.viewers

    def close(self) -> None:
        self.closed = True
        self._wake()

    async def stream(self) -> AsyncIterator[bytes]:
        """Ereignisse fuer einen Zuschauer, bis er die Verbindung schliesst oder der Server endet."""
        self.viewers += 1
        # Laeuft der Tracker gerade, bekommt ein neuer Zuschauer sofort das letzte Bild.
        seen = self.seq if time.monotonic() - self.time > STALE_SECONDS else self.seq - 1
        try:
            while not self.closed:
                if self.seq == seen:
                    changed = self._changed
                    try:
                        await asyncio.wait_for(changed.wait(), PING_SECONDS)
                    except asyncio.TimeoutError:
                        yield b": ping\n\n"
                    continue
                seen = self.seq
                yield b"data: " + self.frame + b"\n\n"
        finally:
            self.viewers -= 1
