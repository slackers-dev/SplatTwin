"""Bestimmt die Gelenke der Person im Splat und schreibt sie nach rig.json.

MediaPipe findet die Gelenke in allen Bildern, in denen die Person zur Kamera
schaut. Jedes Gelenk wird aus diesen Bildern und den bekannten Kameraposen in
3D trianguliert. Das ergibt die mittlere Haltung ueber die Drehung, also die
Haltung, die auch der Splat zeigt. Gelenke, die sich nicht triangulieren lassen,
kommen ersatzweise aus dem ersten Bild (Sehstrahl geschnitten mit der Ebene z = 0).

Aufruf:  splattwin rig <lauf>
"""

import json
import sys
from pathlib import Path

import cv2
import numpy as np

from splattwin import contracts
from splattwin.io.colmap import read_cameras, read_intrinsics
from splattwin.vision.landmarks import detect, landmarks_3d, pose_landmarker

NAMES = {
    0: "nose",
    7: "lEar",
    8: "rEar",
    11: "lSh",
    12: "rSh",
    13: "lEl",
    14: "rEl",
    15: "lWr",
    16: "rWr",
    23: "lHip",
    24: "rHip",
    25: "lKn",
    26: "rKn",
    27: "lAn",
    28: "rAn",
}


def run(run_dir: Path) -> None:
    name = sorted(f.name for f in (run_dir / "frames").iterdir())[0]  # erstes Bild von Video a
    img = cv2.imread(str(run_dir / "frames" / name))
    h, w = img.shape[:2]
    with pose_landmarker() as landmarker:
        tri = landmarks_3d(run_dir, landmarker, list(NAMES))
        lms = detect(landmarker, img)
    if lms is None:
        sys.exit("Keine Person im ersten Bild gefunden.")

    M = np.array(json.loads((run_dir / "splat.json").read_text())["matrix"])
    model = run_dir / "data/sparse/0"
    center, R = read_cameras(model)[name]
    # Brennweite der Kamera, die dieses Bild aufgenommen hat (bei zwei Videos gibt es zwei).
    f, cx, cy = read_intrinsics(model)[name]
    origin = M[:3, :3] @ center + M[:3, 3]

    joints, source = {}, {}
    for i, key in NAMES.items():
        u, v = lms[i].x * w, lms[i].y * h
        ray = M[:3, :3] @ (R.T @ np.array([(u - cx) / f, (v - cy) / f, 1.0]))
        p = origin - origin[2] / ray[2] * ray  # Ersatz: Schnitt mit der Ebene z = 0
        source[key] = "trianguliert" if i in tri else "ein Bild"
        if i in tri:
            p = M[:3, :3] @ tri[i] + M[:3, 3]
        joints[key] = [round(float(x), 4) for x in p]
        cv2.circle(img, (int(u), int(v)), 6, (0, 255, 0), -1)
    contracts.write(run_dir / "rig.json", "run-rig", {"joints": joints, "source": source})
    cv2.imwrite(str(run_dir / "rig_check.jpg"), img)
    for key, p in joints.items():
        print(f"{key:5s} x={p[0]:+.2f} y={p[1]:+.2f} z={p[2]:+.2f}  {source[key]}")
