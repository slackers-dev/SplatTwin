"""Zwei Videos derselben Drehung zeitlich abgleichen, ueber den Ton (einmal klatschen)."""

import subprocess
import sys
from pathlib import Path

import numpy as np


def onset_envelope(path: Path) -> np.ndarray:
    """Lautstaerke-Anstiege im Ton, 1000 Werte pro Sekunde. Ein Klatschen gibt eine Spitze."""
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
        capture_output=True,
    ).stdout
    x = np.abs(np.frombuffer(raw, np.int16).astype(np.float32))
    if len(x) < 8000:
        sys.exit(f"Kein Ton in {path.name}: Versatz von Hand mit --offset angeben.")
    env = x[: len(x) // 8 * 8].reshape(-1, 8).max(axis=1)
    return np.maximum(np.diff(env, prepend=env[0]), 0)


def audio_offset(path_a: Path, path_b: Path) -> float:
    """Sekunden, um die ein Ereignis in Video B spaeter liegt als in Video A.
    Kreuzkorrelation der Anstiege: der Versatz, bei dem beide Tonspuren am besten passen."""
    a, b = onset_envelope(path_a), onset_envelope(path_b)
    n = len(a) + len(b)
    corr = np.fft.irfft(np.fft.rfft(b, n) * np.conj(np.fft.rfft(a, n)), n)
    k = int(np.argmax(corr))
    peak = corr[k] / (np.median(np.abs(corr)) + 1e-9)
    if k > n // 2:
        k -= n
    print(
        f"Ton: lautester Anstieg in {path_a.name} bei {np.argmax(a) / 1000:.2f}s, "
        f"{path_b.name} laeuft {k / 1000:+.3f}s versetzt (Deutlichkeit {peak:.0f})"
    )
    return k / 1000
