"""Schritt 4: Brush trainiert den Gaussian Splat aus data/ (Bilder mit Maske als Alpha und COLMAP-Modell)."""

import sys
from pathlib import Path

from splattwin.paths import BRUSH
from splattwin.shell import run


def run_brush(run_dir: Path, steps: int) -> None:
    if not BRUSH.exists():
        sys.exit(f"Brush fehlt: {BRUSH}. Einrichten siehe README (Abschnitt Brush).")
    run(
        [
            BRUSH,
            run_dir / "data",
            "--total-steps",
            steps,
            "--export-every",
            steps,
            "--export-path",
            run_dir,
            "--export-name",
            "splat.ply",
        ]
    )
    print(f"\nFertig: {run_dir / 'splat.ply'}")
    print(f"Ansehen: {BRUSH} {run_dir / 'splat.ply'}  (oder auf superspl.at/editor ziehen)")
