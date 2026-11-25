import cv2
import numpy as np
from conftest import rotation

from splattwin.server import calibration

W, H, F = 1280, 720, 800.0
K = np.array([[F, 0, W / 2], [0, F, H / 2], [0, 0, 1]])
SQUARE, MARGIN = 40, 40


def board_texture():
    """Schachbrett mit 10 x 7 Feldern und weissem Rand (9 x 6 innere Ecken)."""
    tex = np.full((7 * SQUARE + 2 * MARGIN, 10 * SQUARE + 2 * MARGIN), 255, np.uint8)
    for r in range(7):
        for c in range(10):
            if (r + c) % 2 == 0:
                tex[
                    MARGIN + r * SQUARE : MARGIN + (r + 1) * SQUARE, MARGIN + c * SQUARE : MARGIN + (c + 1) * SQUARE
                ] = 0
    return tex


def render(tex, R, t):
    """Bild einer Kamera mit K, das Brett liegt in seiner Ebene z = 0 (Einheit: ein Feld)."""
    to_board = np.array([[1 / SQUARE, 0, -MARGIN / SQUARE], [0, 1 / SQUARE, -MARGIN / SQUARE], [0, 0, 1]])
    Hm = K @ np.column_stack([R[:, 0], R[:, 1], t]) @ to_board
    return cv2.warpPerspective(tex, Hm, (W, H), borderValue=128)


def test_calibration_finds_focal_length(rng):
    tex = board_texture()
    accepted = 0
    for n in range(14):
        R = rotation(rng.normal(size=3), rng.uniform(0.15, 0.45))
        t = np.array([rng.uniform(-6, -3), rng.uniform(-4, -2), rng.uniform(15, 20)])
        jpeg = cv2.imencode(".jpg", render(tex, R, t), [cv2.IMWRITE_JPEG_QUALITY, 95])[1].tobytes()
        result = calibration.add_view("A", jpeg, reset=n == 0)
        accepted += result["accepted"]
    assert accepted >= calibration.MIN_VIEWS
    k = calibration.calibrate("A")
    assert abs(k["fx"] * W - F) / F < 0.02
    assert abs(k["fy"] * H - F) / F < 0.02
    assert abs(k["cx"] - 0.5) < 0.02 and abs(k["cy"] - 0.5) < 0.02
    assert k["rms"] < 1.0


def test_too_few_views_is_an_error():
    calibration.add_view("B", cv2.imencode(".jpg", np.zeros((40, 40), np.uint8))[1].tobytes(), reset=True)
    try:
        calibration.calibrate("B")
    except ValueError as err:
        assert "mindestens" in str(err)
    else:
        raise AssertionError("ValueError erwartet")
