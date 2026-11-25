"""Schritt 3: Structure from Motion mit COLMAP, nur auf der Person (Masken) -> Kameraposen."""

import shutil
import sys
from pathlib import Path

import cv2
import numpy as np

from splattwin.io.colmap import read_cameras, read_focal
from splattwin.shell import run


def orbit_report(cams: dict, n_frames: int) -> None:
    """Bilden die Kameras einen Kreis? Das ist der Test, ob die Idee traegt.
    Die Mac-App liest diese Zeilen (QualityReport): Wortlaut nur zusammen mit der App aendern."""
    print(f"\nRegistriert: {len(cams)} von {n_frames} Frames")
    for cam in sorted({n[0] for n in cams}):
        names = sorted(n for n in cams if n[0] == cam)
        C = np.array([cams[n][0] for n in names])
        c = C - C.mean(axis=0)
        _, s, vt = np.linalg.svd(c, full_matrices=False)
        xy = c @ vt[:2].T  # Projektion in die Ebene der Kamerabahn
        ang = np.unwrap(np.arctan2(xy[:, 1], xy[:, 0]))
        radius = np.linalg.norm(xy, axis=1)
        print(
            f"Video {cam}: {len(names)} Frames, Kamerabahn {abs(np.degrees(ang[-1] - ang[0])):.0f} Grad Bogen, "
            f"Radius schwankt um {radius.std() / radius.mean():.0%}, "
            f"Abweichung aus der Ebene {s[2] / s[1]:.0%}"
        )
    print("Gut ist: fast alle Frames registriert, etwa 360 Grad, kleine Schwankungen.")


def run_colmap(run_dir: Path, n_frames: int, focal: float | None = None) -> dict:
    """focal: Brennweite als Vielfaches der Bildbreite (aus der App). Ohne Angabe schaetzt
    COLMAP sie selbst; das ist bei einer Person, die sich vor fester Kamera dreht, schlecht
    bestimmt (Schaetzungen lagen bis 20-fach daneben)."""
    db, sparse = run_dir / "colmap.db", run_dir / "sparse_all"
    db.unlink(missing_ok=True)
    shutil.rmtree(sparse, ignore_errors=True)
    sparse.mkdir()
    # Ein Durchgang pro Video: so bekommt jede Kamera ihre eigene Brennweite.
    names = sorted(f.name for f in (run_dir / "frames").iterdir())
    cams_letters = sorted({n[0] for n in names})
    # Die Brennweite der App gilt nur fuer die erste Kamera bzw. den ersten Abschnitt (a).
    # Fest halten nur, wenn es keine weitere Kamera gibt, deren Brennweite geschaetzt werden muss.
    fixed = focal is not None and cams_letters == ["a"]
    for cam in cams_letters:
        listing = run_dir / f"frames_{cam}.txt"
        listing.write_text("\n".join(n for n in names if n[0] == cam) + "\n")
        params = []
        if focal is not None and cam == "a":
            h, w = cv2.imread(str(run_dir / "frames" / next(n for n in names if n[0] == cam))).shape[:2]
            params = ["--ImageReader.camera_params", f"{focal * w:.2f},{w / 2:.2f},{h / 2:.2f}"]
            print(f"Brennweite aus der App: {focal * w:.0f} px bei {w}x{h}" + (" (fest)" if fixed else " (Startwert)"))
        run(
            [
                "colmap",
                "feature_extractor",
                "--database_path",
                db,
                "--image_path",
                run_dir / "frames",
                "--image_list_path",
                listing,
                "--ImageReader.mask_path",
                run_dir / "masks",
                "--ImageReader.camera_model",
                "SIMPLE_PINHOLE",
                "--ImageReader.single_camera",
                1,
                "--FeatureExtraction.use_gpu",
                0,
                *params,
            ]
        )
    # Erschoepfend statt nur Nachbarn: so wird auch der Kreis geschlossen
    # (letzter Frame sieht wieder dasselbe wie der erste).
    run(["colmap", "exhaustive_matcher", "--database_path", db, "--FeatureMatching.use_gpu", 0])
    run(
        [
            "colmap",
            "mapper",
            "--database_path",
            db,
            "--image_path",
            run_dir / "frames",
            "--output_path",
            sparse,
            "--Mapper.ba_refine_focal_length",
            0 if fixed else 1,
        ]
    )
    models = [(read_cameras(m), m) for m in sorted(sparse.iterdir()) if (m / "images.bin").exists()]
    if not models:
        sys.exit("COLMAP hat kein Modell gefunden: zu wenig Merkmale auf der Person.")
    cams, best = max(models, key=lambda x: len(x[0]))
    out = run_dir / "data/sparse/0"
    shutil.rmtree(out, ignore_errors=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(best, out)
    orbit_report(cams, n_frames)
    print(f"Brennweite im Modell: {read_focal(best):.0f} px")
    return cams
