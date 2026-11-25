"""Person freistellen: gelerntes Modell (rembg), Vergleich mit dem leeren Hintergrund, oder beides."""

import sys

import cv2
import numpy as np


def largest_component(mask: np.ndarray) -> np.ndarray:
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if n <= 1:
        return mask
    keep = 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])
    return np.where(labels == keep, 255, 0).astype(np.uint8)


def fill_holes(mask: np.ndarray) -> np.ndarray:
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out = np.zeros_like(mask)
    cv2.drawContours(out, contours, -1, 255, cv2.FILLED)
    return out


def bgdiff_mask(frame: np.ndarray, bg: np.ndarray, thresh: int) -> np.ndarray:
    """Alles, was sich vom leeren Hintergrundbild unterscheidet."""
    diff = cv2.absdiff(cv2.GaussianBlur(frame, (5, 5), 0), cv2.GaussianBlur(bg, (5, 5), 0)).max(axis=2)
    mask = np.where(diff > thresh, 255, 0).astype(np.uint8)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    return cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k)


def make_masks(frames: list[np.ndarray], bg: np.ndarray | None, mode: str, bg_thresh: int) -> list[np.ndarray]:
    """mode: person (gelerntes Modell), bgdiff (nur Hintergrundbild), both, auto (both, falls es ein
    Hintergrundbild gibt, sonst person)."""
    if mode == "auto":
        mode = "both" if bg is not None else "person"
    if mode in ("bgdiff", "both") and bg is None:
        sys.exit(f"--mask {mode} braucht ein Hintergrundbild (--bg-seconds).")
    session = None
    if mode in ("person", "both"):
        from rembg import new_session, remove

        session = new_session("u2net_human_seg")
    masks = []
    for n, frame in enumerate(frames):
        if mode == "bgdiff":
            mask = fill_holes(largest_component(bgdiff_mask(frame, bg, bg_thresh)))
        else:
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mask = np.where(remove(rgb, session=session, only_mask=True) > 127, 255, 0).astype(np.uint8)
            if mode == "both":
                # Das Hintergrundbild darf nur wegnehmen, was das Modell faelschlich
                # als Person sieht. Grosszuegig aufgeblasen, damit Stellen, an denen
                # Kleidung und Hintergrund gleich aussehen, keine Loecher reissen.
                near = cv2.dilate(
                    bgdiff_mask(frame, bg, bg_thresh), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (41, 41))
                )
                mask = cv2.bitwise_and(mask, near)
            mask = largest_component(mask)
        masks.append(mask)
        print(f"\rMasken ({mode}): {n + 1}/{len(frames)}", end="", flush=True)
    print()
    return masks
