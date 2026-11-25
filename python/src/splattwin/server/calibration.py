"""Kamerakalibrierung mit einem Schachbrett (3DRecon 1).

Die Seite schickt Einzelbilder eines Schachbretts, hier werden die Ecken gesucht und daraus
Kameramatrix und Linsenverzeichnung berechnet."""

import threading

import cv2
import numpy as np

from splattwin import contracts

PATTERN = (9, 6)  # innere Ecken des Schachbretts (10 x 7 Felder)
MIN_VIEWS = 8  # so viele Ansichten braucht calibrateCamera mindestens
MIN_SHIFT = 0.02  # neue Ansicht muss sich um 2 % der Bildbreite unterscheiden

_sessions: dict[str, dict] = {}  # Kamera -> {"size": (w, h), "views": [Ecken, ...]}
_lock = threading.Lock()


def find_corners(gray: np.ndarray) -> np.ndarray | None:
    """Sucht das Schachbrett, Rueckgabe: Ecken (N, 1, 2) oder None."""
    found, corners = cv2.findChessboardCornersSB(
        gray, PATTERN, flags=cv2.CALIB_CB_NORMALIZE_IMAGE | cv2.CALIB_CB_ACCURACY
    )
    if found:
        return corners.astype(np.float32)
    found, corners = cv2.findChessboardCorners(
        gray, PATTERN, flags=cv2.CALIB_CB_ADAPTIVE_THRESH | cv2.CALIB_CB_NORMALIZE_IMAGE
    )
    if not found:
        return None
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.001)
    return cv2.cornerSubPix(gray, corners, (11, 11), (-1, -1), criteria)


def add_view(cam: str, jpeg: bytes, reset: bool) -> dict:
    image = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise ValueError("Bild konnte nicht gelesen werden")
    h, w = image.shape
    corners = find_corners(image)

    with _lock:
        session = _sessions.get(cam)
        if reset or session is None or session["size"] != (w, h):
            session = _sessions[cam] = {"size": (w, h), "views": []}
        result = {"found": corners is not None, "accepted": False, "count": len(session["views"])}
        if corners is None:
            return result
        # Fast identische Ansichten bringen nichts: erst uebernehmen, wenn sich das Brett bewegt hat.
        if session["views"]:
            shift = np.abs(session["views"][-1] - corners).mean() / w
            if shift < MIN_SHIFT:
                return result
        session["views"].append(corners)
        result.update(
            accepted=True, count=len(session["views"]), corners=(corners.reshape(-1, 2) / [w, h]).round(4).tolist()
        )
        return result


def calibrate(cam: str) -> dict:
    with _lock:
        session = _sessions.get(cam)
        views = list(session["views"]) if session else []
        size = session["size"] if session else None
    if len(views) < MIN_VIEWS:
        raise ValueError(f"Nur {len(views)} brauchbare Ansichten, mindestens {MIN_VIEWS} noetig")

    # Die Feldgroesse spielt fuer Brennweite und Verzeichnung keine Rolle: Einheit = 1 Feld.
    grid = np.zeros((PATTERN[0] * PATTERN[1], 3), np.float32)
    grid[:, :2] = np.mgrid[0 : PATTERN[0], 0 : PATTERN[1]].T.reshape(-1, 2)
    rms, K, dist, _, _ = cv2.calibrateCamera([grid] * len(views), views, size, None, None)

    w, h = size
    fx, fy, cx, cy = K[0, 0], K[1, 1], K[0, 2], K[1, 2]
    result = {
        # Bezogen auf Bildbreite bzw. -hoehe, damit die Werte auch bei anderer Aufloesung gelten.
        "fx": fx / w,
        "fy": fy / h,
        "cx": cx / w,
        "cy": cy / h,
        "dist": [float(v) for v in dist.ravel()[:5]],
        "rms": float(rms),
        "width": w,
        "height": h,
        "views": len(views),
        "fovY": float(np.degrees(2 * np.arctan(h / (2 * fy)))),
        "fovX": float(np.degrees(2 * np.arctan(w / (2 * fx)))),
    }
    contracts.validate("intrinsics", result)
    return result
