import numpy as np
from conftest import rotation
from test_ply import PROPS

from splattwin.pipeline.merge_head import transform_splats


def test_transform_moves_scales_and_turns_splats(rng):
    table = rng.normal(size=(5, len(PROPS)))
    table[:, 11:15] = [1, 0, 0, 0]  # ohne Drehung
    s, R, t = 2.0, rotation([0, 1, 0], np.pi / 2), np.array([1.0, 0, 0])
    out = transform_splats(PROPS, table.copy(), s, R, t)
    assert np.allclose(out[:, :3], s * table[:, :3] @ R.T + t)
    assert np.allclose(out[:, 8:11], table[:, 8:11] + np.log(s))
    assert np.allclose(np.abs(out[:, 11:15]), [np.cos(np.pi / 4), 0, np.sin(np.pi / 4), 0])
    assert np.all(out[:, PROPS.index("f_rest_0")] == 0)
