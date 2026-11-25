"""Bilder und Masken fuer COLMAP (frames/, masks/) und Brush (data/images/, RGBA) ablegen."""

import shutil
from pathlib import Path

import cv2
import numpy as np


def write_dataset(sets: list[tuple[str, list, list]], run_dir: Path) -> None:
    """sets: pro Video bzw. Brennweite (Buchstabe, Frames, Masken); der Buchstabe steht vorne im Dateinamen."""
    d_frames, d_masks, d_rgba = run_dir / "frames", run_dir / "masks", run_dir / "data/images"
    for d in (d_frames, d_masks, d_rgba):
        shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True)
    erode = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    rows = []
    for cam, frames, masks in sets:
        for n, (frame, mask) in enumerate(zip(frames, masks, strict=True)):
            name = f"{cam}_{n:04d}.png"
            cv2.imwrite(str(d_frames / name), frame)
            # COLMAP: schwarz = ignorieren. Etwas geschrumpft, weil Merkmale direkt am
            # Umriss halb aus Hintergrund bestehen und sich nicht mit der Person drehen.
            cv2.imwrite(str(d_masks / (name + ".png")), cv2.erode(mask, erode))
            soft = cv2.GaussianBlur(mask, (5, 5), 0)
            cv2.imwrite(str(d_rgba / name), np.dstack([frame, soft]))
        rows.append(contact_row(frames, masks))
        cover = np.mean([m.mean() / 255 for m in masks])
        print(f"Video {cam}: Person bedeckt im Schnitt {cover:.0%} des Bildes.")
    width = max(r.shape[1] for r in rows)
    sheet = np.vstack([np.pad(r, ((0, 0), (0, width - r.shape[1]), (0, 0))) for r in rows])
    cv2.imwrite(str(run_dir / "masken_check.jpg"), sheet)
    print(f"Kontrolle der Masken: {run_dir / 'masken_check.jpg'}")


def contact_row(frames: list[np.ndarray], masks: list[np.ndarray]) -> np.ndarray:
    """Kontaktbogen, um die Masken auf einen Blick zu pruefen: bis zu 8 Bilder, Hintergrund abgedunkelt."""
    tiles = []
    for i in np.linspace(0, len(frames) - 1, min(8, len(frames))).astype(int):
        scale = 300 / frames[i].shape[0]
        f = cv2.resize(frames[i], None, fx=scale, fy=scale).astype(np.float32)
        m = cv2.resize(masks[i], None, fx=scale, fy=scale)[..., None] / 255
        tiles.append((f * (0.25 + 0.75 * m)).astype(np.uint8))
    return np.hstack(tiles)
