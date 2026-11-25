import numpy as np


def umeyama(src: np.ndarray, dst: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
    """Massstab s, Drehung R, Verschiebung t mit dst ~ s * R @ src + t (kleinste Quadrate, Umeyama 1991)."""
    ms, md = src.mean(axis=0), dst.mean(axis=0)
    a, b = src - ms, dst - md
    U, S, Vt = np.linalg.svd(b.T @ a / len(src))
    D = np.diag([1, 1, np.sign(np.linalg.det(U) * np.linalg.det(Vt))])
    R = U @ D @ Vt
    s = np.trace(np.diag(S) @ D) / (a**2).sum() * len(src)
    return s, R, md - s * R @ ms
