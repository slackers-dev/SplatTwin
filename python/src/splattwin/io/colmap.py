"""COLMAP-Modelle lesen. Das Binaerformat wird einmal mit `colmap model_converter` nach Text
umgewandelt (Ordner <modell>_txt neben dem Modell) und danach von dort gelesen."""

import subprocess
from pathlib import Path

import numpy as np

from splattwin.geometry.quaternion import rotation_from_quaternion


def text_dir(model_dir: Path) -> Path:
    return model_dir.parent / (model_dir.name + "_txt")


def convert_to_text(model_dir: Path) -> Path:
    txt = text_dir(model_dir)
    txt.mkdir(exist_ok=True)
    subprocess.run(
        ["colmap", "model_converter", "--input_path", model_dir, "--output_path", txt, "--output_type", "TXT"],
        check=True,
        capture_output=True,
    )
    return txt


def _image_rows(txt: Path):
    """Zeilen von images.txt, die ein Bild beschreiben (jede zweite Zeile ist die Punktliste)."""
    lines = [l for l in (txt / "images.txt").read_text().split("\n") if not l.startswith("#")]
    for line in lines[0::2]:
        p = line.split()
        if len(p) >= 10:
            yield p


def _camera_rows(txt: Path):
    for line in (txt / "cameras.txt").read_text().split("\n"):
        if line and not line.startswith("#"):
            yield line.split()


def read_cameras(model_dir: Path) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """Name -> (Kamerazentrum, Rotation Welt->Kamera) aus einem COLMAP-Modell."""
    txt = convert_to_text(model_dir)
    cams = {}
    for p in _image_rows(txt):
        qw, qx, qy, qz, tx, ty, tz = map(float, p[1:8])
        R = rotation_from_quaternion(qw, qx, qy, qz)
        cams[p[9]] = (-R.T @ np.array([tx, ty, tz]), R)
    return cams


def read_focal(model_dir: Path) -> float:
    """Brennweite der ersten Kamera (Pixel). Setzt voraus, dass read_cameras schon lief."""
    for p in _camera_rows(text_dir(model_dir)):
        return float(p[4])
    return 0


def read_intrinsics(model_dir: Path) -> dict[str, tuple[float, float, float]]:
    """Bildname -> (Brennweite, cx, cy) der Kamera, die das Bild aufgenommen hat (SIMPLE_PINHOLE).
    Setzt voraus, dass read_cameras schon lief."""
    txt = text_dir(model_dir)
    cams = {p[0]: tuple(map(float, p[4:7])) for p in _camera_rows(txt)}
    return {p[9]: cams[p[8]] for p in _image_rows(txt)}
