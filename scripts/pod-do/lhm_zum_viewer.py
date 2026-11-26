"""Avatar von LHM++ fuer den Viewer bereitstellen: data/lhm/<name>/avatar.ply -> data/runs/lhm-<name>/.

LHM++ liefert die T-Pose auf SMPL-X: Meter, y oben, Blick nach +z. Es fehlt nur die Verschiebung, damit die
Fuesse bei y = 0 stehen (Vertrag run-splat). Laeuft lokal als `after` von pod-do (siehe pod-do.toml).

    uv run python scripts/pod-do/lhm_zum_viewer.py <name>
"""

import json
import shutil
import sys
from pathlib import Path

from splattwin.io.ply import read_positions

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    name = sys.argv[1]
    src = ROOT / "data" / "lhm" / name / "avatar.ply"
    out = ROOT / "data" / "runs" / f"lhm-{name}"
    out.mkdir(parents=True, exist_ok=True)
    shutil.copy(src, out / "splat.ply")
    pos = read_positions(src)
    feet, top = float(pos[:, 1].min()), float(pos[:, 1].max())
    matrix = [[1, 0, 0, 0], [0, 1, 0, -feet], [0, 0, 1, 0], [0, 0, 0, 1]]
    (out / "splat.json").write_text(
        json.dumps({"matrix": matrix, "height": round(top - feet, 3)}, indent=2)
    )
    print(f"Viewer: viewer.html?run=lhm-{name} (Groesse {top - feet:.2f} m)")


if __name__ == "__main__":
    main()
