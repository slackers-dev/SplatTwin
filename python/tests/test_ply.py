import numpy as np

from splattwin.io.ply import read_ply, read_positions, write_ply

PROPS = [
    "x",
    "y",
    "z",
    "f_dc_0",
    "f_dc_1",
    "f_dc_2",
    "f_rest_0",
    "opacity",
    "scale_0",
    "scale_1",
    "scale_2",
    "rot_0",
    "rot_1",
    "rot_2",
    "rot_3",
]


def make_ply(path, table):
    head = [
        "ply",
        "format binary_little_endian 1.0",
        f"element vertex {len(table)}",
        *[f"property float {p}" for p in PROPS],
        "",
    ]
    path.write_bytes("\n".join(head).encode() + b"end_header\n" + table.astype(np.float32).tobytes())


def test_round_trip(tmp_path, rng):
    table = rng.normal(size=(50, len(PROPS))).astype(np.float32)
    make_ply(tmp_path / "a.ply", table)
    lines, props, read = read_ply(tmp_path / "a.ply")
    assert props == PROPS and np.array_equal(read, table)
    write_ply(tmp_path / "b.ply", lines, read[:20])
    _, _, again = read_ply(tmp_path / "b.ply")
    assert np.array_equal(again, table[:20])
    assert np.array_equal(read_positions(tmp_path / "b.ply"), table[:20, :3])
