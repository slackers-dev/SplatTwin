"""Sehstrahlen: Punkt, der mehreren Strahlen am naechsten liegt (Triangulation aus vielen Bildern)."""

import numpy as np

Ray = tuple[np.ndarray, np.ndarray]  # (Ursprung, Richtung als Einheitsvektor)


def nearest_point(rays: list[Ray]) -> np.ndarray:
    """Punkt mit der kleinsten Summe der quadrierten Abstaende zu allen Strahlen (lineare kleinste Quadrate)."""
    A, b = np.zeros((3, 3)), np.zeros(3)
    for o, d in rays:
        P = np.eye(3) - np.outer(d, d)
        A += P
        b += P @ o
    return np.linalg.solve(A, b)


def distances(p: np.ndarray, rays: list[Ray]) -> np.ndarray:
    return np.array([np.linalg.norm((np.eye(3) - np.outer(d, d)) @ (p - o)) for o, d in rays])


def triangulate(rays: list[Ray]) -> np.ndarray:
    """Wie nearest_point, grobe Ausreisser (mehr als 2.5-mal der mittlere Abstand) fallen weg."""
    p = nearest_point(rays)
    dist = distances(p, rays)
    keep = [r for r, e in zip(rays, dist, strict=True) if e <= 2.5 * np.median(dist) + 1e-9]
    return nearest_point(keep) if len(keep) >= 3 else p
