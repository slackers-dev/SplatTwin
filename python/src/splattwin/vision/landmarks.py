"""Koerperpunkte von MediaPipe Pose, in 3D trianguliert ueber die Bilder eines Laufs."""

from contextlib import contextmanager
from pathlib import Path

import cv2
import numpy as np

from splattwin.geometry.rays import triangulate
from splattwin.io.colmap import read_cameras, read_intrinsics
from splattwin.paths import ensure_pose_model

# Indizes von MediaPipe Pose
NOSE, L_EYE, R_EYE, L_EAR, R_EAR, L_SH, R_SH = 0, 2, 5, 7, 8, 11, 12
# Nase, Augen (innen, Mitte, aussen), Ohren, Mundwinkel, Schultern
HEAD_POINTS = list(range(13))


@contextmanager
def pose_landmarker():
    import mediapipe as mp

    options = mp.tasks.vision.PoseLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(ensure_pose_model()))
    )
    with mp.tasks.vision.PoseLandmarker.create_from_options(options) as landmarker:
        yield landmarker


def detect(landmarker, img: np.ndarray):
    """Koerperpunkte im BGR-Bild, oder None, wenn keine Person gefunden wurde."""
    import mediapipe as mp

    res = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(img, cv2.COLOR_BGR2RGB)))
    return res.pose_landmarks[0] if res.pose_landmarks else None


def landmarks_3d(run_dir: Path, landmarker, points=HEAD_POINTS) -> dict[int, np.ndarray]:
    """Trianguliert Koerperpunkte eines Laufs. Liefert {Index: Punkt} in COLMAP-Koordinaten."""
    cams = read_cameras(run_dir / "data/sparse/0")
    K = read_intrinsics(run_dir / "data/sparse/0")
    rays = {i: [] for i in points}
    used = 0
    for name in sorted(cams):
        img = cv2.imread(str(run_dir / "frames" / name))
        h, w = img.shape[:2]
        lm = detect(landmarker, img)
        if lm is None:
            continue
        # Nur Bilder, in denen die Person zur Kamera schaut: dann liegt ihr linkes Auge
        # im Bild rechts vom rechten. Von hinten vertauscht das Modell gern die Seiten.
        if lm[L_EYE].x <= lm[R_EYE].x or min(lm[i].visibility for i in (NOSE, L_EYE, R_EYE)) < 0.8:
            continue
        used += 1
        C, R = cams[name]
        f, cx, cy = K[name]
        for i in points:
            p = lm[i]
            if p.visibility < 0.7 or not (0.02 < p.x < 0.98 and 0.02 < p.y < 0.98):
                continue
            d = R.T @ np.array([(p.x * w - cx) / f, (p.y * h - cy) / f, 1.0])
            rays[i].append((C, d / np.linalg.norm(d)))
    pts = {i: triangulate(r) for i, r in rays.items() if len(r) >= 4}
    print(f"{run_dir.name}: {used} Bilder von vorne, {len(pts)} von {len(points)} Punkten trianguliert")
    return pts
