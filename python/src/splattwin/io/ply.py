"""PLY-Dateien von Gaussian Splats (binaer, nur float-Felder, wie Brush sie schreibt)."""

from pathlib import Path

import numpy as np


def read_ply(path: Path) -> tuple[list[str], list[str], np.ndarray]:
    """Liefert (Kopfzeilen, Feldnamen, Tabelle mit einer Zeile pro Klecks)."""
    data = Path(path).read_bytes()
    head, body = data.split(b"end_header\n", 1)
    lines = head.decode().split("\n")
    count = next(int(l.split()[2]) for l in lines if l.startswith("element vertex"))
    props = [l.split()[2] for l in lines if l.startswith("property float")]
    table = np.frombuffer(body, np.float32, count * len(props)).reshape(count, len(props)).copy()
    return lines, props, table


def write_ply(path: Path, lines: list[str], table: np.ndarray) -> None:
    head = "\n".join(l if not l.startswith("element vertex") else f"element vertex {len(table)}" for l in lines)
    Path(path).write_bytes(head.encode() + b"end_header\n" + table.astype(np.float32).tobytes())


def read_positions(path: Path) -> np.ndarray:
    """Nur die Mittelpunkte der Kleckse, (N, 3)."""
    _, props, table = read_ply(path)
    return table[:, [props.index(a) for a in "xyz"]]
