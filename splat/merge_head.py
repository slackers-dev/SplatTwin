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

Aufruf:  uv run merge_head.py runs/<koerper> runs/<kopf>
Ergebnis: runs/<koerper>/splat.ply (der alte liegt daneben als splat_koerper.ply)
"""
import json
import shutil
import sys
import urllib.request
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np

from splat_pipeline import HERE, read_cameras

MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task"
# Nase, Augen (innen, Mitte, aussen), Ohren, Mundwinkel, Schultern
POINTS = list(range(13))
L_EYE, R_EYE, L_EAR, R_EAR, L_SH, R_SH = 2, 5, 7, 8, 11, 12


def intrinsics(model_dir):
    """Bildname -> (Brennweite, cx, cy)."""
    txt = model_dir.parent / (model_dir.name + "_txt")
    cams = {l.split()[0]: tuple(map(float, l.split()[4:7]))
            for l in (txt / "cameras.txt").read_text().split("\n") if l and not l.startswith("#")}
    lines = [l for l in (txt / "images.txt").read_text().split("\n") if not l.startswith("#")]
    return {p[9]: cams[p[8]] for p in (l.split() for l in lines[0::2]) if len(p) >= 10}


def triangulate(rays):
    """Punkt, der allen Strahlen (Ursprung, Richtung) am naechsten liegt; grobe Ausreisser fallen weg."""
    def solve(rs):
        A, b = np.zeros((3, 3)), np.zeros(3)
        for o, d in rs:
            P = np.eye(3) - np.outer(d, d)
            A += P
            b += P @ o
        return np.linalg.solve(A, b)
    p = solve(rays)
    dist = np.array([np.linalg.norm((np.eye(3) - np.outer(d, d)) @ (p - o)) for o, d in rays])
    keep = [r for r, e in zip(rays, dist) if e <= 2.5 * np.median(dist) + 1e-9]
    return solve(keep) if len(keep) >= 3 else p


def landmarks_3d(run_dir, landmarker, points=POINTS):
    """Trianguliert Koerperpunkte eines Laufs. Liefert {Index: Punkt} in COLMAP-Koordinaten."""
    cams = read_cameras(run_dir / "data/sparse/0")
    K = intrinsics(run_dir / "data/sparse/0")
    rays = {i: [] for i in points}
    used = 0
    for name in sorted(cams):
        img = cv2.imread(str(run_dir / "frames" / name))
        h, w = img.shape[:2]
        res = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(img, cv2.COLOR_BGR2RGB)))
        if not res.pose_landmarks:
            continue
        lm = res.pose_landmarks[0]
        # Nur Bilder, in denen die Person zur Kamera schaut: dann liegt ihr linkes Auge
        # im Bild rechts vom rechten. Von hinten vertauscht das Modell gern die Seiten.
        if lm[L_EYE].x <= lm[R_EYE].x or min(lm[i].visibility for i in (0, L_EYE, R_EYE)) < 0.8:
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


def umeyama(src, dst):
    """Massstab s, Drehung R, Verschiebung t mit dst ~ s * R @ src + t (kleinste Quadrate)."""
    ms, md = src.mean(axis=0), dst.mean(axis=0)
    a, b = src - ms, dst - md
    U, S, Vt = np.linalg.svd(b.T @ a / len(src))
    D = np.diag([1, 1, np.sign(np.linalg.det(U) * np.linalg.det(Vt))])
    R = U @ D @ Vt
    s = np.trace(np.diag(S) @ D) / (a ** 2).sum() * len(src)
    return s, R, md - s * R @ ms


def read_ply(path):
    data = path.read_bytes()
    head, body = data.split(b"end_header\n", 1)
    lines = head.decode().split("\n")
    count = next(int(l.split()[2]) for l in lines if l.startswith("element vertex"))
    props = [l.split()[2] for l in lines if l.startswith("property float")]
    table = np.frombuffer(body, np.float32, count * len(props)).reshape(count, len(props)).copy()
    return lines, props, table


def write_ply(path, lines, table):
    head = "\n".join(l if not l.startswith("element vertex") else f"element vertex {len(table)}" for l in lines)
    path.write_bytes(head.encode() + b"end_header\n" + table.astype(np.float32).tobytes())


def quat_mul(a, b):
    """Quaternionen (w, x, y, z), a einzeln, b als Tabelle."""
    w1, x1, y1, z1 = a
    w2, x2, y2, z2 = b.T
    return np.stack([w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2, w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
                     w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2, w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2], axis=1)


def rot_to_quat(R):
    w = np.sqrt(max(0, 1 + R[0, 0] + R[1, 1] + R[2, 2])) / 2
    if w > 1e-6:
        return np.array([w, (R[2, 1] - R[1, 2]) / (4 * w), (R[0, 2] - R[2, 0]) / (4 * w), (R[1, 0] - R[0, 1]) / (4 * w)])
    axis = np.linalg.eigh(R)[1][:, -1]  # Drehung um 180 Grad
    return np.array([0, *axis])


def transform_splats(props, table, s, R, t):
    """Wendet die Aehnlichkeitsabbildung auf Lage, Groesse und Ausrichtung der Kleckse an."""
    col = lambda names: [props.index(n) for n in names]
    xyz, scale, rot = col("xyz"), col(["scale_0", "scale_1", "scale_2"]), col(["rot_0", "rot_1", "rot_2", "rot_3"])
    table[:, xyz] = s * table[:, xyz] @ R.T + t
    table[:, scale] += np.log(s)  # Groessen sind als Logarithmus gespeichert
    table[:, rot] = quat_mul(rot_to_quat(R), table[:, rot])
    # Die blickabhaengigen Farbanteile muessten mitgedreht werden; einfacher: weglassen.
    table[:, [i for i, n in enumerate(props) if n.startswith("f_rest_")]] = 0
    return table


def main():
    body_dir, head_dir = (Path(a).resolve() for a in sys.argv[1:3])
    model = HERE / "tools/pose_landmarker_heavy.task"
    if not model.exists():
        urllib.request.urlretrieve(MODEL_URL, model)
    options = mp.tasks.vision.PoseLandmarkerOptions(base_options=mp.tasks.BaseOptions(model_asset_path=str(model)))
    with mp.tasks.vision.PoseLandmarker.create_from_options(options) as landmarker:
        body_pts = landmarks_3d(body_dir, landmarker)
        head_pts = landmarks_3d(head_dir, landmarker)
    # Nur Punkte am Kopf: der Kopf ist starr, die Schultern stehen in der Nahaufnahme oft anders.
    common = sorted((set(body_pts) & set(head_pts)) - {L_SH, R_SH})
    if len(common) < 5:
        sys.exit(f"Nur {len(common)} gemeinsame Punkte, mindestens 5 noetig. Kopf und Koerper lassen sich so nicht verbinden.")
    src = np.array([head_pts[i] for i in common])
    dst = np.array([body_pts[i] for i in common])
    s, R, t = umeyama(src, dst)

    # In aufrechten Koerper-Koordinaten (Meter, y oben) pruefen und schneiden.
    M = np.array(json.loads((body_dir / "splat.json").read_text())["matrix"])
    up = lambda p: p @ M[:3, :3].T + M[:3, 3]
    metres = np.linalg.norm(M[:3, 0])
    err = np.linalg.norm(s * src @ R.T + t - dst, axis=1) * metres
    print(f"{len(common)} gemeinsame Punkte, Abweichung nach dem Ausrichten: "
          f"Mittel {err.mean() * 100:.1f} cm, groesste {err.max() * 100:.1f} cm")
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
    assert head_props == props, "Koerper- und Kopf-Splat haben verschiedene Felder"
    head = transform_splats(props, head, s, R, t)
    xyz = [props.index(a) for a in "xyz"]
    body_keep = body[up(body[:, xyz])[:, 1] < cut]
    # Vom Kopf-Scan nur, was ueber dem Schnitt und nahe am Kopf liegt (sonst ragen Kragen
    # und Schultern der Nahaufnahme seitlich heraus).
    ears = up(np.array([body_pts[L_EAR], body_pts[R_EAR]])).mean(axis=0)
    hp = up(head[:, xyz])
    head_keep = head[(hp[:, 1] >= cut) & (np.linalg.norm(hp - ears, axis=1) < 0.19)]
    write_ply(body_dir / "splat.ply", lines, np.vstack([body_keep, head_keep]))
    (body_dir / "head.json").write_text(json.dumps({
        "points": len(common), "error_cm_mean": round(float(err.mean() * 100), 2),
        "error_cm_max": round(float(err.max() * 100), 2), "cut_height_m": round(float(cut), 3),
        "body_splats": len(body_keep), "head_splats": len(head_keep)}, indent=1))
    print(f"Schnitt am Hals auf {cut:.2f} m: {len(body_keep)} Kleckse vom Koerper, {len(head_keep)} vom Kopf")
    print(f"Geschrieben: {body_dir / 'splat.ply'} (Original: {original.name})")


if __name__ == "__main__":
    main()
