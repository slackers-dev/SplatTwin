"""Bestimmt die Gelenke der Person im Splat und schreibt sie nach rig.json.

MediaPipe findet die Gelenke in allen Bildern, in denen die Person zur Kamera
schaut. Jedes Gelenk wird aus diesen Bildern und den bekannten Kameraposen in
3D trianguliert. Das ergibt die mittlere Haltung ueber die Drehung, also die
Haltung, die auch der Splat zeigt. Gelenke, die sich nicht triangulieren lassen,
kommen ersatzweise aus dem ersten Bild (Sehstrahl geschnitten mit der Ebene z = 0).

Aufruf:  uv run rig_splat.py runs/IMG_0706
"""
import json
import sys
import urllib.request
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np

from merge_head import landmarks_3d
from splat_pipeline import HERE, read_cameras

MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task"
NAMES = {0: "nose", 7: "lEar", 8: "rEar", 11: "lSh", 12: "rSh", 13: "lEl", 14: "rEl", 15: "lWr", 16: "rWr",
         23: "lHip", 24: "rHip", 25: "lKn", 26: "rKn", 27: "lAn", 28: "rAn"}


def main():
    run_dir = Path(sys.argv[1]).resolve()
    model = HERE / "tools/pose_landmarker_heavy.task"
    if not model.exists():
        urllib.request.urlretrieve(MODEL_URL, model)

    name = sorted(f.name for f in (run_dir / "frames").iterdir())[0]  # erstes Bild von Video a
    img = cv2.imread(str(run_dir / "frames" / name))
    h, w = img.shape[:2]
    options = mp.tasks.vision.PoseLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(model)))
    with mp.tasks.vision.PoseLandmarker.create_from_options(options) as landmarker:
        tri = landmarks_3d(run_dir, landmarker, list(NAMES))
        result = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(img, cv2.COLOR_BGR2RGB)))
    if not result.pose_landmarks:
        sys.exit("Keine Person im ersten Bild gefunden.")
    lms = result.pose_landmarks[0]

    M = np.array(json.loads((run_dir / "splat.json").read_text())["matrix"])
    center, R = read_cameras(run_dir / "data/sparse/0")[name]
    # Brennweite der Kamera, die dieses Bild aufgenommen hat (bei zwei Videos gibt es zwei).
    txt = run_dir / "data/sparse/0_txt"
    cam_id = next(l.split()[8] for l in (txt / "images.txt").read_text().split("\n") if l.endswith(" " + name))
    f, cx, cy = map(float, next(l for l in (txt / "cameras.txt").read_text().split("\n")
                                if l.split()[:1] == [cam_id]).split()[4:7])
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
    (run_dir / "rig.json").write_text(json.dumps({"joints": joints, "source": source}, indent=1))
    cv2.imwrite(str(run_dir / "rig_check.jpg"), img)
    for key, p in joints.items():
        print(f"{key:5s} x={p[0]:+.2f} y={p[1]:+.2f} z={p[2]:+.2f}  {source[key]}")


if __name__ == "__main__":
    main()
