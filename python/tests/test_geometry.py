import numpy as np
from conftest import rotation

from splattwin.geometry import quaternion
from splattwin.geometry.rays import nearest_point, triangulate
from splattwin.geometry.similarity import umeyama


def rays_to(point, origins):
    out = []
    for o in origins:
        d = point - o
        out.append((o, d / np.linalg.norm(d)))
    return out


def test_nearest_point_hits_exact_intersection(rng):
    p = np.array([0.3, 1.2, -0.4])
    assert np.allclose(nearest_point(rays_to(p, rng.normal(size=(6, 3)) * 3)), p)


def test_triangulate_drops_outlier(rng):
    p = np.array([0.3, 1.2, -0.4])
    rays = rays_to(p, rng.normal(size=(8, 3)) * 3)
    o, d = rays[0]
    wrong = d + np.array([0.4, -0.3, 0.2])
    rays[0] = (o, wrong / np.linalg.norm(wrong))
    assert np.linalg.norm(nearest_point(rays) - p) > 0.01
    assert np.allclose(triangulate(rays), p, atol=1e-6)


def test_umeyama_recovers_similarity(rng):
    src = rng.normal(size=(10, 3))
    R = rotation([1, 2, 3], 0.7)
    s, t = 2.5, np.array([1.0, -2.0, 0.5])
    s2, R2, t2 = umeyama(src, s * src @ R.T + t)
    assert np.isclose(s2, s) and np.allclose(R2, R) and np.allclose(t2, t)


def test_quaternion_round_trip():
    for axis, angle in [([0, 0, 1], 0.3), ([1, 1, 0], 2.0), ([0, 1, 0], np.pi)]:
        R = rotation(axis, angle)
        q = quaternion.quaternion_from_rotation(R)
        assert np.allclose(quaternion.rotation_from_quaternion(*q), R)


def test_quaternion_multiply_composes_rotations():
    a, b = rotation([1, 0, 0], 0.4), rotation([0, 1, 1], 1.1)
    qa, qb = quaternion.quaternion_from_rotation(a), quaternion.quaternion_from_rotation(b)
    q = quaternion.multiply(qa, qb[None])[0]
    assert np.allclose(quaternion.rotation_from_quaternion(*q), a @ b)
