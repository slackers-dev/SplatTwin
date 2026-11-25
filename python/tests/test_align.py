import json

import numpy as np
from conftest import rotation
from test_ply import PROPS, make_ply

from splattwin import contracts
from splattwin.pipeline.align import write_pose


def test_pose_stands_person_upright_at_height(tmp_path, rng):
    # Person steht entlang einer schiefen Achse im COLMAP-Raum, Massstab beliebig (0.5 Einheiten pro Meter).
    tilt = rotation([1, 0.3, 0], 0.6)
    up, center = tilt @ [0, 1, 0], np.array([2.0, -1.0, 3.0])
    unit = 0.5
    heights = rng.uniform(0, 1.8, 4000)
    positions = center + np.outer(heights * unit, up) + (rng.normal(size=(4000, 3)) * 0.05 * unit) @ tilt.T
    table = np.zeros((len(positions), len(PROPS)), np.float32)
    table[:, :3] = positions
    make_ply(tmp_path / "splat.ply", table)

    # Kameras auf einem Kreis um die Person in Brusthoehe, Blick zur Achse, y der Kamera nach unten.
    cams = {}
    for k, a in enumerate(np.linspace(0, 2 * np.pi, 40, endpoint=False)):
        C = center + up * 1.3 * unit + tilt @ [3 * np.sin(a), 0, 3 * np.cos(a)]
        z = center + up * 1.3 * unit - C
        z /= np.linalg.norm(z)
        y = -up - (-up @ z) * z
        y /= np.linalg.norm(y)
        cams[f"a_{k:04d}.png"] = (C, np.array([np.cross(y, z), y, z]))

    write_pose(tmp_path, cams, height=1.8)
    data = contracts.read(tmp_path / "splat.json", "run-splat")
    M = np.array(data["matrix"])
    world = positions @ M[:3, :3].T + M[:3, 3]
    lo, hi = np.percentile(world[:, 1], [0.5, 99.5])
    assert abs(lo) < 0.02 and abs(hi - 1.8) < 0.02  # Fuesse am Boden, Kopf auf Koerpergroesse
    assert np.allclose(np.median(world[:, [0, 2]], axis=0), 0, atol=0.02)  # in der Mitte
    # Erstes Bild: die Kamera steht vorne (+z)
    first = M[:3, :3] @ cams["a_0000.png"][0] + M[:3, 3]
    assert first[2] > 1 and abs(first[0]) < 0.05
    assert json.loads((tmp_path / "splat.json").read_text())["height"] == 1.8
