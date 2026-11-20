"""Rechnet eine Aufnahme der Seite capture.html vollstaendig durch.

Liest die Zeiten aus captures/<name>.json und startet nacheinander:
  1. Koerper-Splat aus der Drehung (nur Kamera A, das Handy)
  2. Kopf-Splat aus dem Gesichtsscan, falls aufgenommen
  3. Kopf auf den Koerper setzen (merge_head.py)
  4. Gelenke fuer den Avatar bestimmen (rig_splat.py)

Aufruf:  uv run process_capture.py captures/<name>.json
"""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def step(title, *cmd):
    print(f"\n=== {title}\n$ uv run {' '.join(str(c) for c in cmd)}", flush=True)
    return subprocess.run(["uv", "run", "-q", *map(str, cmd)], cwd=HERE).returncode == 0


def main():
    meta_path = Path(sys.argv[1]).resolve()
    meta = json.loads(meta_path.read_text())
    marks, name = meta["marks"], meta["name"]
    video = meta_path.parent / meta["saved"]["a"]["saved"]
    body, head = HERE / "runs" / name, HERE / "runs" / f"{name}_kopf"
    bg = ["--max-size", 1920]  # volle Aufloesung der Aufnahme behalten
    if meta.get("height"):  # Koerpergroesse aus der Splattwin-App: Massstab des Splats
        bg += ["--height", meta["height"]]

    if "bgStart" in marks:
        bg += ["--bg-start", round(marks["bgStart"] + 0.3, 1), "--bg-seconds", round(marks["bgEnd"] - 0.3, 1)]

    if "turnStart" not in marks:
        # Gesichtsscan als eigene Aufnahme (Splattwin-App): nur der Kopf-Splat. Steht in "body" der Name
        # einer Koerper-Aufnahme, wird der Kopf dort aufgesetzt.
        if "faceStart" not in marks:
            sys.exit("In der Aufnahme ist weder eine Koerperdrehung noch ein Gesichtsscan markiert.")
        target = meta.get("body") or ""
        head = HERE / "runs" / (f"{target}_kopf" if target else name)
        if not step("Kopf-Splat", "splat_pipeline.py", video, *bg, "--start", round(marks["faceStart"], 1),
                    "--end", round(marks["faceEnd"], 1), "--out", head):
            sys.exit("Kopf-Splat fehlgeschlagen.")
        if target and (HERE / "runs" / target / "splat.ply").exists():
            if step("Kopf auf Koerper setzen", "merge_head.py", HERE / "runs" / target, head):
                print(f"\nAnsehen: http://127.0.0.1:8931/splat.html?run={target}"
                      f"\nAvatar:  http://127.0.0.1:8931/index.html?run={target}")
        elif target:
            print(f"\nKoerper-Lauf {target} gibt es noch nicht: zuerst dessen Splat rechnen, dann diesen Schritt wiederholen.")
        return
    if not step("Koerper-Splat", "splat_pipeline.py", video, *bg, "--start", round(marks["turnStart"], 1),
                "--end", round(marks["turnEnd"], 1), "--out", body):
        sys.exit("Koerper-Splat fehlgeschlagen.")
    if "faceStart" in marks:
        ok = step("Kopf-Splat", "splat_pipeline.py", video, *bg, "--start", round(marks["faceStart"], 1),
                  "--end", round(marks["faceEnd"], 1), "--out", head)
        ok = ok and step("Kopf auf Koerper setzen", "merge_head.py", body, head)
        if not ok:
            print("\nGesichtsscan nicht verwendbar: der Splat bleibt ohne scharfen Kopf.")
    step("Gelenke fuer den Avatar", "rig_splat.py", body)
    print(f"\nAnsehen: http://127.0.0.1:8931/splat.html?run={name}"
          f"\nAvatar:  http://127.0.0.1:8931/index.html?run={name}")


if __name__ == "__main__":
    main()
