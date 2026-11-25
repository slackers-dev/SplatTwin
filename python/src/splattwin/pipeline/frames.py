"""Schritt 1: scharfe Einzelbilder aus dem Video waehlen, Hintergrundbild aus dem leeren Raum."""

import sys
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


@dataclass
class Window:
    """Zeitangaben in Sekunden im Video (vor dem Versatz eines zweiten Videos)."""

    bg_start: float = 0  # ab hier ist der Raum leer
    bg_end: float = 0  # bis hier ist der Raum leer
    start: float = 0  # Person steht in Pose und beginnt zu drehen
    end: float = 0  # Drehung fertig (0 = Videoende)


def resize(img: np.ndarray, max_size: int) -> np.ndarray:
    h, w = img.shape[:2]
    s = max_size / max(h, w)
    return img if s >= 1 else cv2.resize(img, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA)


def read_video(path: Path, window: Window, n_frames: int, max_size: int, offset: float = 0.0):
    """Liefert (Hintergrundbild oder None, Liste von Frame-Gruppen).
    offset verschiebt alle Zeitangaben (zweites Video). Wechselt die Kamera waehrend der
    Drehung sprunghaft den Bildausschnitt (z.B. automatischer Zoom oder Linsenwechsel des
    Handys), gilt danach eine andere Brennweite: die Frames werden dort in Gruppen geteilt."""
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        sys.exit(f"Video nicht lesbar: {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    total = cap.get(cv2.CAP_PROP_FRAME_COUNT) / fps
    if window.start < window.bg_end:
        sys.exit("--start muss nach dem Ende des leeren Hintergrunds (--bg-seconds) liegen.")
    bg0, bg1, start = window.bg_start + offset, window.bg_end + offset, window.start + offset
    end = window.end + offset if window.end else total
    # Das Zeitfenster in gleich lange Abschnitte teilen und je den schaerfsten
    # Frame nehmen (Varianz des Laplace-Filters als Schaerfemass).
    slot_len = (end - start) / n_frames
    bg_frames, best = [], {}
    edge_prev, edge_diffs = None, []  # Bildrand ueber die Zeit: dort steht nie die Person
    i = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        t = i / fps
        i += 1
        if t < bg1:
            if t >= bg0 and i % max(1, int((bg1 - bg0) * fps / 40)) == 0:
                bg_frames.append(resize(frame, max_size))
            continue
        if t < start or t >= end:
            continue
        frame = resize(frame, max_size)
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        if i % 5 == 0:
            small = cv2.resize(gray, (160, 90)).astype(np.float32)
            edge = np.concatenate([small[:, :30].ravel(), small[:, -30:].ravel()])
            if edge_prev is not None:
                edge_diffs.append((t, float(np.abs(edge - edge_prev).mean())))
            edge_prev = edge
        sharp = cv2.Laplacian(gray, cv2.CV_64F).var()
        slot = int((t - start) / slot_len)
        if slot not in best or sharp > best[slot][0]:
            best[slot] = (sharp, frame, t)
    cap.release()
    # Ein Sprung ist viel groesser als das uebliche Rauschen am Bildrand.
    typical = np.median([d for _, d in edge_diffs]) if edge_diffs else 0
    jumps = [t for t, d in edge_diffs if d > max(10 * typical, 15)]
    cuts = [t for n, t in enumerate(jumps) if n == 0 or t - jumps[n - 1] > 1.5]
    groups = [[] for _ in range(len(cuts) + 1)]
    for k in sorted(best):
        _, frame, t = best[k]
        if any(abs(t - c) < 0.6 for c in cuts):
            continue  # waehrend des Wechsels ist das Bild unbrauchbar
        groups[sum(t > c for c in cuts)].append(frame)
    if cuts:
        print(
            f"{path.name}: Bildausschnitt wechselt bei "
            + ", ".join(f"{c - offset:.1f}s" for c in cuts)
            + " -> getrennte Brennweiten davor und danach"
        )
    frames = [f for g in groups for f in g]
    # Der Median ueber die Zeit entfernt Rauschen aus dem leeren Hintergrund.
    bg = np.median(np.stack(bg_frames), axis=0).astype(np.uint8) if bg_frames else None
    print(
        f"{path.name}: {total:.1f}s @ {fps:.0f}fps -> {len(frames)} Frames, "
        f"Hintergrundbild: {'ja' if bg is not None else 'nein'}"
    )
    return bg, groups
