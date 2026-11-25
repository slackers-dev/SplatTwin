"""Buehne: bis zu zwei Presenter (Platz A und B) und die Folien, live fuer alle Zuschauer.

Die Tracking-Seite schickt ueber einen WebSocket (/ws/send) pro Bild die Gelenkpunkte im Binaerformat
aus web/src/live/protocol.ts und bei Aenderung Name und Splat-Lauf (contracts/stage-meta). Bühne und
Regie empfangen ueber /ws/stage alles: Folienstand (contracts/stage-slides), Platz-Infos und die Bilder
mit einem Byte fuer den Platz davor. Der Server liest die Bilder nicht, er prueft nur die Laenge.

Pro Kanal zaehlt nur der neueste Stand: ein langsamer Zuschauer bekommt weniger Bilder statt einer
wachsenden Verzoegerung (wie server/live.py). Folien und Platz-Infos ueberleben einen Neustart
(data/stage/), damit die Buehne die Splats schon beim Oeffnen laden kann.
"""

import asyncio
import json
import re
import time
from collections.abc import AsyncIterator, Callable
from pathlib import Path

from splattwin import contracts

SLOTS = ("A", "B")
PING_SECONDS = 15  # so oft wacht ein wartender Zuschauer auf, um zu pruefen, ob er noch da ist
STALE_SECONDS = 2  # so lange ohne Bild gilt ein Presenter als weg
MAX_PDF = 200 * 1024 * 1024
MAX_SKIN = 64 * 1024 * 1024

# Binaerformat eines Bildes (web/src/live/protocol.ts): Kopf 14 Bytes, je Gelenk 6, je Hand 21 * 6.
FRAME_VERSION = 1
FRAME_HEADER = 14
BODY_JOINTS = 17
HAND_BYTES = 21 * 6


def frame_ok(data: bytes) -> bool:
    """Passt die Laenge zu Version, Gelenkmaske und Haenden? Mehr prueft der Server nicht."""
    if len(data) < FRAME_HEADER or data[0] != FRAME_VERSION:
        return False
    flags, mask = data[1], int.from_bytes(data[10:14], "little")
    if mask >> BODY_JOINTS:
        return False
    hands = bool(flags & 4) + bool(flags & 8)
    return len(data) == FRAME_HEADER + mask.bit_count() * 6 + hands * HAND_BYTES


class Stage:
    """Letzter Stand pro Kanal: Bilder von A und B ("A", "B"), Platz-Infos ("meta:A", "meta:B") und
    Folien ("slides"). Jede Aenderung setzt das aktuelle Event und legt ein frisches an: alle
    wartenden Zuschauer wachen auf."""

    def __init__(self, folder: Path):
        self.folder = folder
        self.items: dict[str, tuple[int, bytes, float]] = {}
        self.version = 0
        self.viewers = 0
        self.closed = False
        self._changed = asyncio.Event()
        self._load()

    # ------------------------------------------------------------------ Kanaele
    def _wake(self) -> None:
        self._changed.set()
        self._changed = asyncio.Event()

    def publish(self, key: str, data: bytes) -> int:
        self.version += 1
        self.items[key] = (self.version, data, time.monotonic())
        self._wake()
        return self.viewers

    def get(self, key: str) -> bytes | None:
        item = self.items.get(key)
        return item[1] if item else None

    def wake(self) -> None:
        """Wartende Zuschauer pruefen lassen, ob sie noch verbunden sind."""
        self._wake()

    def close(self) -> None:
        self.closed = True
        self._wake()

    async def stream(self, alive: Callable[[], bool]) -> AsyncIterator[tuple[str, bytes]]:
        """Aenderungen fuer einen Zuschauer, bis alive() falsch wird oder der Server endet.
        Veraltete Bilder (Presenter gerade weg) gibt es beim Verbinden nicht, Folien und Platz-Infos schon."""
        self.viewers += 1
        now = time.monotonic()
        seen = {k: v if k in SLOTS and now - t > STALE_SECONDS else v - 1 for k, (v, _, t) in self.items.items()}
        try:
            while not self.closed and alive():
                fresh = [(k, d) for k, (v, d, _) in self.items.items() if seen.get(k) != v]
                if not fresh:
                    changed = self._changed
                    try:
                        await asyncio.wait_for(changed.wait(), PING_SECONDS)
                    except TimeoutError:
                        pass
                    continue
                for k, d in fresh:
                    seen[k] = self.items[k][0]
                    yield k, d
        finally:
            self.viewers -= 1

    # ------------------------------------------------------------------ Platz-Infos
    def set_meta(self, slot: str, data: object) -> None:
        contracts.validate("stage-meta", data)
        body = json.dumps(data, ensure_ascii=False).encode()
        if self.get("meta:" + slot) == body:
            return
        self.publish("meta:" + slot, body)
        seats = {s: json.loads(m) for s in SLOTS if (m := self.get("meta:" + s))}
        self._write("seats.json", json.dumps(seats, ensure_ascii=False).encode())

    # ------------------------------------------------------------------ Folien
    @property
    def pdf(self) -> Path:
        return self.folder / "slides.pdf"

    def slides(self) -> dict:
        return json.loads(self.get("slides") or b"{}")

    def set_slides(self, **change) -> dict:
        state = self.slides() | change
        if state["pages"]:
            state["page"] = max(1, min(int(state["page"]), int(state["pages"])))
        contracts.validate("stage-slides", state)
        body = json.dumps(state, ensure_ascii=False).encode()
        self._write("slides.json", body)
        self.publish("slides", body)
        return state

    def save_pdf(self, data: bytes, name: str) -> dict:
        if len(data) > MAX_PDF:
            raise ValueError("PDF zu gross (max. 200 MB)")
        if not data.startswith(b"%PDF"):
            raise ValueError("Das ist kein PDF. PowerPoint: Datei > Exportieren > PDF")
        self._write("slides.pdf", data)
        return self.set_slides(doc=str(time.time_ns() // 1_000_000), page=1, pages=0, name=name[:80])

    # ------------------------------------------------------------------ Dateien
    def _write(self, name: str, data: bytes) -> None:
        self.folder.mkdir(parents=True, exist_ok=True)
        tmp = self.folder / (name + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(self.folder / name)

    def _load(self) -> None:
        empty = {"doc": None, "page": 1, "pages": 0}
        try:
            state = json.loads((self.folder / "slides.json").read_text())
            contracts.validate("stage-slides", state)
        except (OSError, ValueError, contracts.ContractError):
            state = empty
        if state["doc"] and not self.pdf.exists():
            state = empty
        self.publish("slides", json.dumps(state, ensure_ascii=False).encode())
        try:
            seats = json.loads((self.folder / "seats.json").read_text())
        except (OSError, ValueError):
            seats = {}
        for slot in SLOTS:
            try:
                contracts.validate("stage-meta", seats.get(slot))
                self.publish("meta:" + slot, json.dumps(seats[slot], ensure_ascii=False).encode())
            except contracts.ContractError:
                pass


# ---------------------------------------------------------------------- vorgerechneter Splat
SKIN_MAGIC = b"SKN1"


def skin_path(runs: Path, run: str) -> Path:
    if not re.fullmatch(r"[\w-]{1,60}", run) or not (runs / run / "splat.ply").exists():
        raise ValueError("unbekannter Lauf")
    return runs / run / "skin.bin"


def save_skin(runs: Path, run: str, data: bytes) -> dict:
    """Zuordnung der Kleckse zum Skelett, einmal im Browser gerechnet (web/src/avatar/skin-cache.ts)."""
    path = skin_path(runs, run)
    if len(data) > MAX_SKIN:
        raise ValueError("Datei zu gross")
    if not data.startswith(SKIN_MAGIC):
        raise ValueError("kein vorgerechneter Splat")
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)
    return {"saved": f"{run}/skin.bin", "bytes": len(data)}


def skin_current(runs: Path, run: str) -> bool:
    """skin.bin gilt nur, solange der Splat nicht neu gerechnet wurde."""
    try:
        path = skin_path(runs, run)
    except ValueError:
        return False
    return path.exists() and path.stat().st_mtime >= (runs / run / "splat.ply").stat().st_mtime
