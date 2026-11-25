"""Aufnahmen aus dem Browser (capture.html) speichern."""

import json
import re
import subprocess
from pathlib import Path

import cv2

from splattwin import contracts
from splattwin.paths import CAPTURES

NAME = re.compile(r"[A-Za-z0-9_-]{1,40}")
ROTATE = {"90": ["-vf", "transpose=1"], "270": ["-vf", "transpose=2"]}


def check(name: str, cam: str, kind: str) -> None:
    if not NAME.fullmatch(name) or cam not in ("a", "b") or kind not in ("webm", "mp4", "json"):
        raise ValueError("ungueltige Angaben zur Aufnahme")


def save_meta(name: str, body: bytes) -> dict:
    """Metadatei der Aufnahme, geprueft gegen contracts/capture."""
    contracts.validate("capture", json.loads(body))
    CAPTURES.mkdir(parents=True, exist_ok=True)
    (CAPTURES / f"{name}.json").write_bytes(body)
    return {"saved": f"{name}.json"}


def raw_path(name: str, cam: str, kind: str) -> Path:
    """Ablage fuer die Rohdatei des Browser-Rekorders."""
    CAPTURES.mkdir(parents=True, exist_ok=True)
    return CAPTURES / f"{name}_{cam}.roh.{kind}"


def convert(name: str, cam: str, raw: Path, rot: str) -> dict:
    """Wandelt die Rohdatei in ein MP4 mit festen 30 Bildern pro Sekunde um (die Rohdatei des
    Browsers hat unregelmaessige Zeitstempel). Hochkant stehendes Handy: rot = 90 oder 270."""
    final = CAPTURES / f"{name}_{cam}.mp4"
    done = subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(raw), *ROTATE.get(rot, []), "-r", "30", "-c:v", "libx264",
         "-crf", "15", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an", str(final)],
        capture_output=True, text=True,
    )  # fmt: skip
    if done.returncode != 0:
        raise ValueError("Umwandlung fehlgeschlagen: " + done.stderr.strip()[-300:])
    cap = cv2.VideoCapture(str(final))
    info = {
        "saved": final.name,
        "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
        "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
        "seconds": round(cap.get(cv2.CAP_PROP_FRAME_COUNT) / 30, 2),
    }
    cap.release()
    return info
