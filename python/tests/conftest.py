import numpy as np
import pytest


@pytest.fixture
def rng():
    return np.random.default_rng(7)


def rotation(axis, angle):
    """Rotationsmatrix um eine Achse (Rodrigues)."""
    axis = np.asarray(axis, float) / np.linalg.norm(axis)
    K = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + np.sin(angle) * K + (1 - np.cos(angle)) * K @ K
