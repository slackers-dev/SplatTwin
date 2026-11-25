"""Quaternionen in der Reihenfolge (w, x, y, z), wie COLMAP und die PLY-Felder rot_0..rot_3."""

import numpy as np


def rotation_from_quaternion(qw: float, qx: float, qy: float, qz: float) -> np.ndarray:
    return np.array(
        [
            [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
            [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
            [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
        ]
    )


def quaternion_from_rotation(R: np.ndarray) -> np.ndarray:
    w = np.sqrt(max(0, 1 + R[0, 0] + R[1, 1] + R[2, 2])) / 2
    if w > 1e-6:
        return np.array(
            [w, (R[2, 1] - R[1, 2]) / (4 * w), (R[0, 2] - R[2, 0]) / (4 * w), (R[1, 0] - R[0, 1]) / (4 * w)]
        )
    axis = np.linalg.eigh(R)[1][:, -1]  # Drehung um 180 Grad
    return np.array([0, *axis])


def multiply(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """a * b, a einzeln, b als Tabelle (N, 4)."""
    w1, x1, y1, z1 = a
    w2, x2, y2, z2 = b.T
    return np.stack(
        [
            w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
            w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
            w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
            w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
        ],
        axis=1,
    )
