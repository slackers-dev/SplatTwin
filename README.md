# SplatTwin

Projekt im Modul CVAI: eine Person als Gaussian Splat aufnehmen und live per Kamera-Tracking bewegen.

- **Web-Seiten** (`index.html`, `capture.html`, `splat.html`, JS-Dateien, `server.py`): Tracking, Aufnahme, Splat-Viewer
- **Splat-Pipeline** (`splat/`): Video → Einzelbilder → Masken → COLMAP → Brush → `splat.ply`
- **Apps** (`app/`): Mac- und iPhone-App für Aufnahme und Kameras, siehe [`app/README.md`](app/README.md)
- Anforderungen: [`APP_ANFORDERUNGEN.md`](APP_ANFORDERUNGEN.md)

## Einrichten nach dem Klonen

Voraussetzungen (Homebrew): `uv`, `ffmpeg`, `colmap`. Für die Apps zusätzlich Xcode 26.

Grosse Dateien sind **nicht im Repo** und müssen selbst geholt werden. Sie gehören nach `splat/tools/`:

```sh
cd splat
mkdir -p tools/brush
```

### 1. Brush (Splat-Training)

Die Pipeline erwartet `splat/tools/brush/brush-app-aarch64-apple-darwin/brush_app` (getestet mit Version 0.3.0).

```sh
cd splat/tools/brush
curl -LO https://github.com/ArthurBrussee/brush/releases/download/v0.3.0/brush-app-aarch64-apple-darwin.tar.xz
tar -xf brush-app-aarch64-apple-darwin.tar.xz
xattr -dr com.apple.quarantine brush-app-aarch64-apple-darwin   # sonst blockiert macOS das Programm
```

Releases: https://github.com/ArthurBrussee/brush/releases

### 2. MediaPipe Pose-Modell

`rig_splat.py` und `merge_head.py` laden `splat/tools/pose_landmarker_heavy.task` beim ersten Start selbst herunter.
Das klappt nur, wenn der Ordner `splat/tools/` schon existiert (siehe `mkdir` oben). Von Hand:

```sh
curl -L -o splat/tools/pose_landmarker_heavy.task \
  https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task
```

### 3. Python

Die Skripte in `splat/` geben ihre Pakete im Kopf an (PEP 723). Mit `uv run` wird alles automatisch installiert:

```sh
cd splat
uv run splat_pipeline.py video.mov --bg-start 1 --bg-seconds 4 --start 8 --end 30
```

## Was nicht ins Repo kommt

Siehe `.gitignore`: Bilder und Videos, Aufnahmen (`splat/captures/`), Ergebnisse (`splat/runs/`),
Tools (`splat/tools/`), Build-Ordner, `.venv` und `.yappy`.
