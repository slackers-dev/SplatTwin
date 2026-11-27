"""Avatar von LHM++ fuer Viewer und Tracking bereitstellen: data/lhm/<name>/avatar.ply -> data/runs/lhm-<name>/.

LHM++ liefert die T-Pose auf SMPL-X: Meter, y oben, Blick nach +z. Dazu kommen:
- splat.json: nur eine Verschiebung, damit die Fuesse bei y = 0 stehen (Vertrag run-splat)
- smplx.json + smplx_skin.bin: SMPL-X-Skelett und die Gewichte jedes Gaussians (aus skin.npz, das
  lhm_export.py auf dem Pod schreibt). Damit verformt der Splat-Avatar wie LHM++ selbst.
- rig.json: Gelenke fuer den alten Weg ueber das Roboter-Skelett. Der Splat wird von vorne gerendert,
  MediaPipe findet die Gelenke im Bild, die Tiefe kommt aus den Gaussians an dieser Stelle.

Laeuft lokal als `after` von pod-do (siehe pod-do.toml).

    uv run python scripts/pod-do/lhm_zum_viewer.py <name>             # data/lhm/<name>
    uv run python scripts/pod-do/lhm_zum_viewer.py <name> exavatar    # data/exavatar/<name>/avatar

ExAvatar (exavatar_export.py) liefert dasselbe Format, nur in seiner eigenen kanonischen Haltung.
"""

import json
import shutil
import sys
from pathlib import Path

import cv2
import numpy as np
from splattwin import contracts
from splattwin.io.ply import read_ply
from splattwin.vision.landmarks import detect, pose_landmarker

ROOT = Path(__file__).resolve().parents[2]
SH_C0 = 0.28209479177387814
PX_PER_M = 500
NAMES = {
    0: "nose", 7: "lEar", 8: "rEar", 11: "lSh", 12: "rSh", 13: "lEl", 14: "rEl", 15: "lWr", 16: "rWr",
    23: "lHip", 24: "rHip", 25: "lKn", 26: "rKn", 27: "lAn", 28: "rAn",
}  # fmt: skip


def render_front(xyz: np.ndarray, rgb: np.ndarray) -> tuple[np.ndarray, float, float]:
    """Orthografisch von vorne (Kamera bei +z): Bild-x = Welt-x, Bild-y = -Welt-y. Naeheres deckt Fernes."""
    pad = 0.15
    x0, y1 = float(xyz[:, 0].min()) - pad, float(xyz[:, 1].max()) + pad
    w = int((xyz[:, 0].max() + pad - x0) * PX_PER_M)
    h = int((y1 - xyz[:, 1].min() + pad) * PX_PER_M)
    img = np.full((h, w, 3), 255, np.uint8)
    u = ((xyz[:, 0] - x0) * PX_PER_M).astype(int)
    v = ((y1 - xyz[:, 1]) * PX_PER_M).astype(int)
    bgr = (np.clip(rgb, 0, 1) * 255).astype(np.uint8)[:, ::-1]
    for i in np.argsort(xyz[:, 2]):  # hinten zuerst
        cv2.circle(img, (u[i], v[i]), 4, bgr[i].tolist(), -1)
    return img, x0, y1


def joints_from_render(
    xyz: np.ndarray, img: np.ndarray, x0: float, y1: float
) -> dict[str, list[float]]:
    with pose_landmarker() as lm:
        pts = detect(lm, img)
    if pts is None:
        raise SystemExit("MediaPipe findet im Render keine Person")
    h, w = img.shape[:2]
    out = {}
    for idx, name in NAMES.items():
        x = x0 + pts[idx].x * w / PX_PER_M
        y = y1 - pts[idx].y * h / PX_PER_M
        near = np.hypot(xyz[:, 0] - x, xyz[:, 1] - y) < 0.04
        z = (
            float((xyz[near, 2].min() + xyz[near, 2].max()) / 2)
            if near.sum() > 5
            else 0.0
        )
        out[name] = [round(float(x), 4), round(float(y), 4), round(z, 4)]
    return out


def write_smplx(skin: Path, out: Path, feet: float, count: int) -> None:
    """smplx.json (Vertrag run-smplx) und smplx_skin.bin: pro Klecks die 4 staerksten Gelenke."""
    d = np.load(skin)
    w = d["weights"].astype(np.float32)
    if len(w) != count:
        raise SystemExit(f"skin.npz hat {len(w)} Gewichte, splat.ply {count} Kleckse")
    idx = np.argsort(-w, axis=1)[:, :4]
    top = np.take_along_axis(w, idx, axis=1).clip(0)
    top /= top.sum(1, keepdims=True)
    w8 = np.round(top * 255).astype(np.uint8)
    (out / "smplx_skin.bin").write_bytes(idx.astype(np.uint8).tobytes() + w8.tobytes())
    joints = d["joints"] + np.array([0, -feet, 0])
    meta = {
        "joints": [[round(float(c), 5) for c in p] for p in joints],
        "parents": [int(p) for p in d["parents"]],
        "count": count,
    }
    contracts.validate("run-smplx", meta)
    (out / "smplx.json").write_text(json.dumps(meta))
    print(
        f"SMPL-X: {count} Kleckse, Anteil der 4 staerksten Gelenke im Mittel {w[np.arange(count)[:, None], idx].sum(1).mean():.3f}"
    )


def main() -> None:
    name = sys.argv[1]
    kind = sys.argv[2] if len(sys.argv) > 2 else "lhm"
    folder = (
        ROOT / "data" / "lhm" / name
        if kind == "lhm"
        else ROOT / "data" / kind / name / "avatar"
    )
    src = folder / "avatar.ply"
    run = f"{kind}-{name}"
    out = ROOT / "data" / "runs" / run
    out.mkdir(parents=True, exist_ok=True)
    shutil.copy(src, out / "splat.ply")
    # skin.bin (alter Weg, von der Tracking-Seite vorgerechnet) passt nicht mehr zum neuen PLY
    (out / "skin.bin").unlink(missing_ok=True)

    _, props, table = read_ply(src)
    col = {p: i for i, p in enumerate(props)}
    xyz = table[:, [col["x"], col["y"], col["z"]]]
    rgb = 0.5 + SH_C0 * table[:, [col["f_dc_0"], col["f_dc_1"], col["f_dc_2"]]]
    alpha = 1 / (1 + np.exp(-table[:, col["opacity"]]))
    keep = alpha > 0.1
    feet, top = float(xyz[:, 1].min()), float(xyz[:, 1].max())

    matrix = [[1, 0, 0, 0], [0, 1, 0, -feet], [0, 0, 1, 0], [0, 0, 0, 1]]
    (out / "splat.json").write_text(
        json.dumps({"matrix": matrix, "height": round(top - feet, 3)}, indent=2)
    )

    skin = folder / "skin.npz"
    if skin.exists():
        write_smplx(skin, out, feet, len(xyz))
    else:
        print("Kein skin.npz: nur der alte Weg ueber das Roboter-Skelett")

    img, x0, y1 = render_front(xyz[keep], rgb[keep])
    joints = joints_from_render(xyz[keep], img, x0, y1)
    # rig.json in Weltkoordinaten, also mit derselben Verschiebung wie splat.json
    joints = {k: [p[0], round(p[1] - feet, 4), p[2]] for k, p in joints.items()}
    rig = {"joints": joints, "source": {k: "ein Bild" for k in joints}}
    (out / "rig.json").write_text(json.dumps(rig, indent=2))
    # Kontrollbild: gefundene Gelenke im Render
    for p in joints.values():
        uv = (int((p[0] - x0) * PX_PER_M), int((y1 - (p[1] + feet)) * PX_PER_M))
        cv2.circle(img, uv, 7, (0, 0, 255), 2)
    cv2.imwrite(str(out / "rig_render.jpg"), img)

    print(
        f"Viewer: viewer.html?run={run}, Avatar: tracking.html?run={run} (Groesse {top - feet:.2f} m)"
    )


if __name__ == "__main__":
    main()
