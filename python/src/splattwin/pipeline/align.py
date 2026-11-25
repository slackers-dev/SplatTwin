"""Splat aufrichten, auf den Boden stellen und auf Koerpergroesse bringen (splat.json)."""

from pathlib import Path

import numpy as np

from splattwin import contracts
from splattwin.geometry.rays import nearest_point
from splattwin.io.ply import read_positions


def write_pose(run_dir: Path, cams: dict, height: float) -> None:
    """COLMAP legt Lage und Massstab der Welt willkuerlich fest. Aus der Kamerabahn
    folgt, wo oben und vorne ist: die Bahnebene steht senkrecht zur Drehachse der
    Person, und im ersten Bild schaut die Person in die Kamera."""
    names = sorted(cams)  # das erste Bild von Video a kommt zuerst
    C = np.array([cams[n][0] for n in names])
    Rs = [cams[n][1] for n in names]
    cam_up = np.mean([-R[1] for R in Rs], axis=0)  # Kamera-y zeigt nach unten
    up = np.zeros(3)
    for cam in sorted({n[0] for n in names}):
        Cc = np.array([cams[n][0] for n in names if n[0] == cam])
        normal = np.linalg.svd(Cc - Cc.mean(axis=0))[2][2]
        # Lange Bahnen bestimmen die Ebene genauer als kurze Stuecke: nach Laenge gewichten.
        up += (normal if normal @ cam_up > 0 else -normal) * len(Cc) ** 2
    up /= np.linalg.norm(up)
    # Mittelpunkt: der Punkt, der allen Blickachsen am naechsten liegt.
    center = nearest_point([(c, R[2]) for c, R in zip(C, Rs, strict=True)])
    front = C[0] - center
    front -= (front @ up) * up
    front /= np.linalg.norm(front)
    rot = np.array([np.cross(up, front), up, front])
    # Massstab und Mitte immer aus dem reinen Koerper-Splat (ohne aufgesetzten Kopf-Scan).
    body = run_dir / "splat_koerper.ply"
    positions = read_positions(body if body.exists() else run_dir / "splat.ply")
    h = (positions - center) @ up
    lo, hi = np.percentile(h, [0.5, 99.5])
    s = height / (hi - lo)
    M = np.eye(4)
    M[:3, :3] = s * rot
    M[:3, 3] = -s * rot @ center - np.array([0, s * lo, 0])
    # Die Kamera zielt nicht immer genau auf die Person: in die Mitte ruecken, wo die Kleckse liegen.
    xz = np.median(positions @ M[:3, :3].T + M[:3, 3], axis=0)
    M[0, 3] -= xz[0]
    M[2, 3] -= xz[2]
    contracts.write(run_dir / "splat.json", "run-splat", {"matrix": M.tolist(), "height": height})
