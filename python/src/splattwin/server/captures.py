"""Aufnahmen aus dem Browser (capture.html) speichern."""

import json
import re
import subprocess

import cv2

from splattwin import contracts
from splattwin.paths import CAPTURES


def save_capture(query: dict, stream, length: int) -> dict:
    """Speichert eine Aufnahme aus dem Browser und wandelt sie in ein MP4 mit festen
    30 Bildern pro Sekunde um (die Rohdatei des Browsers hat unregelmaessige Zeitstempel)."""
    name = query.get("name", [""])[0]
    cam = query.get("cam", [""])[0]
    kind = query.get("kind", ["webm"])[0]
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", name) or cam not in ("a", "b") or kind not in ("webm", "mp4", "json"):
        raise ValueError("ungueltige Angaben zur Aufnahme")
    CAPTURES.mkdir(parents=True, exist_ok=True)
    if kind == "json":
        body = stream.read(length)
        contracts.validate("capture", json.loads(body))
        (CAPTURES / f"{name}.json").write_bytes(body)
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
    done = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-i",
            str(raw),
            *turn,
            "-r",
            "30",
            "-c:v",
            "libx264",
            "-crf",
            "15",
            "-preset",
            "veryfast",
            "-pix_fmt",
            "yuv420p",
            "-an",
            str(final),
        ],
        capture_output=True,
        text=True,
    )
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
