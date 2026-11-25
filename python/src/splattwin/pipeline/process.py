"""Rechnet eine Aufnahme (capture.json von capture.html oder der Mac-App) vollstaendig durch.

Liest die Zeiten aus data/captures/<name>.json und startet nacheinander:
  1. Koerper-Splat aus der Drehung (nur Kamera A, das Handy)
  2. Kopf-Splat aus dem Gesichtsscan, falls aufgenommen
  3. Kopf auf den Koerper setzen (merge-head)
  4. Gelenke fuer den Avatar bestimmen (rig)

Jeder Schritt laeuft als eigener Prozess: so gibt er seinen Speicher wieder frei, und ein
fehlgeschlagener Kopf-Scan bricht die Aufnahme nicht ab.

Aufruf:  splattwin process <name>   oder   splattwin process data/captures/<name>.json
"""

import subprocess
import sys
from pathlib import Path

from splattwin import contracts
from splattwin.paths import CAPTURES, ROOT, RUNS

VIEW = "http://127.0.0.1:8931"


def step(title: str, *cmd) -> bool:
    print(f"\n=== {title}\n$ splattwin {' '.join(str(c) for c in cmd)}", flush=True)
    return subprocess.run([sys.executable, "-m", "splattwin", *map(str, cmd)], cwd=ROOT).returncode == 0


def capture_path(name_or_path: str) -> Path:
    path = Path(name_or_path)
    return (path if path.suffix == ".json" else CAPTURES / f"{name_or_path}.json").resolve()


def links(run: str) -> str:
    return f"\nAnsehen: {VIEW}/viewer.html?run={run}\nAvatar:  {VIEW}/tracking.html?run={run}"


def run(name_or_path: str) -> None:
    meta_path = capture_path(name_or_path)
    if not meta_path.exists():
        sys.exit(f"Aufnahme nicht gefunden: {meta_path}")
    try:
        meta = contracts.read(meta_path, "capture")
    except contracts.ContractError as err:
        sys.exit(f"Metadatei der Aufnahme ungueltig: {err}")
    marks, name = meta["marks"], meta["name"]
    video = meta_path.parent / meta["saved"]["a"]["saved"]
    body, head = RUNS / name, RUNS / f"{name}_kopf"
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
        head = RUNS / (f"{target}_kopf" if target else name)
        if not step(
            "Kopf-Splat",
            "splat",
            video,
            *bg,
            "--start",
            round(marks["faceStart"], 1),
            "--end",
            round(marks["faceEnd"], 1),
            "--out",
            head,
        ):
            sys.exit("Kopf-Splat fehlgeschlagen.")
        if target and (RUNS / target / "splat.ply").exists():
            if step("Kopf auf Koerper setzen", "merge-head", RUNS / target, head):
                print(links(target))
        elif target:
            print(
                f"\nKoerper-Lauf {target} gibt es noch nicht: zuerst dessen Splat rechnen, "
                "dann diesen Schritt wiederholen."
            )
        return
    if not step(
        "Koerper-Splat",
        "splat",
        video,
        *bg,
        "--start",
        round(marks["turnStart"], 1),
        "--end",
        round(marks["turnEnd"], 1),
        "--out",
        body,
    ):
        sys.exit("Koerper-Splat fehlgeschlagen.")
    if "faceStart" in marks:
        ok = step(
            "Kopf-Splat",
            "splat",
            video,
            *bg,
            "--start",
            round(marks["faceStart"], 1),
            "--end",
            round(marks["faceEnd"], 1),
            "--out",
            head,
        )
        ok = ok and step("Kopf auf Koerper setzen", "merge-head", body, head)
        if not ok:
            print("\nGesichtsscan nicht verwendbar: der Splat bleibt ohne scharfen Kopf.")
    step("Gelenke fuer den Avatar", "rig", body)
    print(links(name))
