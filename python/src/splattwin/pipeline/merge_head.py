"""Setzt einen Kopf-Splat (Nahaufnahme) auf einen Koerper-Splat.

Beide Splats stammen aus getrennten Rekonstruktionen und haben darum verschiedene
Koordinatensysteme und Massstaebe. Die Verbindung sind Punkte, die in beiden
vorkommen: Nase, Augen, Ohren, Mundwinkel.

  1. MediaPipe findet diese Punkte in den Bildern, in denen die Person zur Kamera schaut.
  2. Aus mehreren Bildern und den bekannten Kameraposen wird jeder Punkt in 3D
     trianguliert, einmal im Koerper-Lauf und einmal im Kopf-Lauf.
  3. Aus den Punktpaaren folgt die Aehnlichkeitsabbildung Kopf -> Koerper
     (Drehung, Verschiebung, Massstab; Verfahren von Umeyama).
  4. Am Hals wird geschnitten: unten bleibt der Koerper-Splat, oben kommt der Kopf-Splat.

Aufruf:  splattwin merge-head <koerper> <kopf>
Ergebnis: <koerper>/splat.ply (der alte liegt daneben als splat_koerper.ply)
"""

import json
import shutil
import sys
from pathlib import Path

import numpy as np

from splattwin.geometry import quaternion
from splattwin.geometry.similarity import umeyama
from splattwin.io.ply import read_ply, write_ply
from splattwin.vision.landmarks import L_EAR, L_SH, R_EAR, R_SH, landmarks_3d, pose_landmarker


def transform_splats(props: list[str], table: np.ndarray, s: float, R: np.ndarray, t: np.ndarray) -> np.ndarray:
    """Wendet die Aehnlichkeitsabbildung auf Lage, Groesse und Ausrichtung der Kleckse an."""

    def col(names):
        return [props.index(n) for n in names]

    xyz, scale, rot = col("xyz"), col(["scale_0", "scale_1", "scale_2"]), col(["rot_0", "rot_1", "rot_2", "rot_3"])
    table[:, xyz] = s * table[:, xyz] @ R.T + t
    table[:, scale] += np.log(s)  # Groessen sind als Logarithmus gespeichert
    table[:, rot] = quaternion.multiply(quaternion.quaternion_from_rotation(R), table[:, rot])
    # Die blickabhaengigen Farbanteile muessten mitgedreht werden; einfacher: weglassen.
    table[:, [i for i, n in enumerate(props) if n.startswith("f_rest_")]] = 0
    return table


def run(body_dir: Path, head_dir: Path) -> None:
    with pose_landmarker() as landmarker:
        body_pts = landmarks_3d(body_dir, landmarker)
        head_pts = landmarks_3d(head_dir, landmarker)
    # Nur Punkte am Kopf: der Kopf ist starr, die Schultern stehen in der Nahaufnahme oft anders.
    common = sorted((set(body_pts) & set(head_pts)) - {L_SH, R_SH})
    if len(common) < 5:
        sys.exit(
            f"Nur {len(common)} gemeinsame Punkte, mindestens 5 noetig. "
            "Kopf und Koerper lassen sich so nicht verbinden."
        )
    src = np.array([head_pts[i] for i in common])
    dst = np.array([body_pts[i] for i in common])
    s, R, t = umeyama(src, dst)

    # In aufrechten Koerper-Koordinaten (Meter, y oben) pruefen und schneiden.
    M = np.array(json.loads((body_dir / "splat.json").read_text())["matrix"])

    def up(p):
        return p @ M[:3, :3].T + M[:3, 3]

    metres = np.linalg.norm(M[:3, 0])
    err = np.linalg.norm(s * src @ R.T + t - dst, axis=1) * metres
    print(
        f"{len(common)} gemeinsame Punkte, Abweichung nach dem Ausrichten: "
        f"Mittel {err.mean() * 100:.1f} cm, groesste {err.max() * 100:.1f} cm"
    )
    if not {L_EAR, R_EAR, L_SH, R_SH} <= set(body_pts):
        sys.exit("Ohren oder Schultern im Koerper-Lauf nicht trianguliert: Schnitthoehe am Hals unbekannt.")
    ear_y = up(np.array([body_pts[L_EAR], body_pts[R_EAR]]))[:, 1].mean()
    sh_y = up(np.array([body_pts[L_SH], body_pts[R_SH]]))[:, 1].mean()
    cut = sh_y + 0.45 * (ear_y - sh_y)

    original = body_dir / "splat_koerper.ply"
    if not original.exists():
        shutil.copy(body_dir / "splat.ply", original)
    lines, props, body = read_ply(original)
    _, head_props, head = read_ply(head_dir / "splat.ply")
    if head_props != props:
        sys.exit("Koerper- und Kopf-Splat haben verschiedene Felder")
    head = transform_splats(props, head, s, R, t)
    xyz = [props.index(a) for a in "xyz"]
    body_keep = body[up(body[:, xyz])[:, 1] < cut]
    # Vom Kopf-Scan nur, was ueber dem Schnitt und nahe am Kopf liegt (sonst ragen Kragen
    # und Schultern der Nahaufnahme seitlich heraus).
    ears = up(np.array([body_pts[L_EAR], body_pts[R_EAR]])).mean(axis=0)
    hp = up(head[:, xyz])
    head_keep = head[(hp[:, 1] >= cut) & (np.linalg.norm(hp - ears, axis=1) < 0.19)]
    write_ply(body_dir / "splat.ply", lines, np.vstack([body_keep, head_keep]))
    (body_dir / "head.json").write_text(
        json.dumps(
            {
                "points": len(common),
                "error_cm_mean": round(float(err.mean() * 100), 2),
                "error_cm_max": round(float(err.max() * 100), 2),
                "cut_height_m": round(float(cut), 3),
                "body_splats": len(body_keep),
                "head_splats": len(head_keep),
            },
            indent=1,
        )
    )
    print(f"Schnitt am Hals auf {cut:.2f} m: {len(body_keep)} Kleckse vom Koerper, {len(head_keep)} vom Kopf")
    print(f"Geschrieben: {body_dir / 'splat.ply'} (Original: {original.name})")
