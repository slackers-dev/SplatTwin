"""Orte im Projektordner. Daten liegen in data/ (nicht im Repo), mit SPLATTWIN_DATA aenderbar."""

import os
import urllib.request
from pathlib import Path

# python/src/splattwin/paths.py -> Projektordner
ROOT = Path(__file__).resolve().parents[3]
DATA = Path(os.environ.get("SPLATTWIN_DATA", ROOT / "data")).resolve()
CAPTURES = DATA / "captures"  # Aufnahmen: Videos und Metadateien
RUNS = DATA / "runs"  # Ergebnisse der Pipeline, ein Ordner pro Lauf
TOOLS = DATA / "tools"  # Brush und Modelle

CONTRACTS = ROOT / "contracts"
WEB_DIST = ROOT / "web" / "dist"

BRUSH = TOOLS / "brush/brush-app-aarch64-apple-darwin/brush_app"
POSE_MODEL = TOOLS / "pose_landmarker_heavy.task"
POSE_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
    "pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task"
)


def run_dir(name_or_path: str | Path) -> Path:
    """Ordner eines Laufs: ein vorhandener Pfad oder ein Name unter data/runs/."""
    path = Path(name_or_path)
    return (path if path.exists() or path.is_absolute() or len(path.parts) > 1 else RUNS / path).resolve()


def ensure_pose_model() -> Path:
    """Laedt das MediaPipe-Modell beim ersten Gebrauch herunter."""
    if not POSE_MODEL.exists():
        POSE_MODEL.parent.mkdir(parents=True, exist_ok=True)
        print(f"Lade das Pose-Modell nach {POSE_MODEL} …", flush=True)
        urllib.request.urlretrieve(POSE_MODEL_URL, POSE_MODEL)
    return POSE_MODEL
