# SplatTwin

Projekt im Modul CVAI: eine Person als Gaussian Splat aufnehmen und live per Kamera-Tracking bewegen.

- **Web-Seiten** (`index.html`, `capture.html`, `splat.html`, JS-Dateien, `server.py`): Tracking, Aufnahme, Splat-Viewer
- **Splat-Pipeline** (`splat/`): Video → Einzelbilder → Masken → COLMAP → Brush → `splat.ply`
- **Apps** (`app/`): Mac- und iPhone-App für Aufnahme und Kameras, siehe [`app/README.md`](app/README.md)
- Anforderungen: [`docs/app-anforderungen.md`](docs/app-anforderungen.md)

## Einrichten nach dem Klonen

Voraussetzungen (Homebrew): `uv`, `ffmpeg`, `colmap` (getestet mit COLMAP 4.2). Für die Apps zusätzlich Xcode 26.

```sh
brew install uv ffmpeg colmap
```

### 1. Python

Alle Python-Teile (`server.py` und die Skripte in `splat/`) teilen eine Umgebung. Die Pakete stehen in
`pyproject.toml`, die genauen Versionen in `uv.lock` (mit einchecken). Python 3.12 ist über `.python-version`
festgelegt, weil es mediapipe nur bis 3.12 gibt; uv lädt es bei Bedarf selbst.

```sh
uv sync            # legt .venv an und installiert genau die Versionen aus uv.lock
```

Danach läuft alles mit `uv run`, auch aus dem Ordner `splat/` heraus. Neue Pakete mit `uv add <paket>`,
nicht mit `pip`, damit `uv.lock` stimmt.

Grosse Dateien sind **nicht im Repo** und müssen selbst geholt werden. Sie gehören nach `splat/tools/`:

```sh
mkdir -p splat/tools/brush
```

### 2. Brush (Splat-Training)

Die Pipeline erwartet `splat/tools/brush/brush-app-aarch64-apple-darwin/brush_app` (getestet mit Version 0.3.0).

```sh
cd splat/tools/brush
curl -LO https://github.com/ArthurBrussee/brush/releases/download/v0.3.0/brush-app-aarch64-apple-darwin.tar.xz
tar -xf brush-app-aarch64-apple-darwin.tar.xz
xattr -dr com.apple.quarantine brush-app-aarch64-apple-darwin   # sonst blockiert macOS das Programm
```

Releases: https://github.com/ArthurBrussee/brush/releases

### 3. MediaPipe Pose-Modell

`rig_splat.py` und `merge_head.py` laden `splat/tools/pose_landmarker_heavy.task` beim ersten Start selbst herunter.
Das klappt nur, wenn der Ordner `splat/tools/` schon existiert (siehe `mkdir` oben). Von Hand:

```sh
curl -L -o splat/tools/pose_landmarker_heavy.task \
  https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task
```

## Starten

```sh
uv run server.py 8931                  # Seiten und Kalibrierung: http://127.0.0.1:8931/index.html

cd splat                               # Splat aus einem Video rechnen
uv run splat_pipeline.py video.mov --bg-start 1 --bg-seconds 4 --start 8 --end 30
uv run rig_splat.py runs/video         # Gelenke für den Avatar
```

Ergebnis ansehen: `splat.html?run=video`, als Avatar `index.html?run=video`.

## Live zuschauen

Die Tracking-Seite kann den Avatar live an andere Seiten senden: nur die Gelenkpunkte, kein Video.

```sh
uv run server.py 8931 --lan   # ohne --lan nur auf diesem Rechner
```

Auf der Tracking-Seite «Avatar an Zuschauer senden» einschalten; dort steht auch die Adresse für andere
Geräte im WLAN (`http://<IP>:8931/live.html`). Geräte im Netz sehen nur die Zuschauerseite und den Splat,
senden, aufnehmen und kalibrieren geht nur am Rechner selbst.

## Was nicht ins Repo kommt

Siehe `.gitignore`: Bilder und Videos, Aufnahmen (`splat/captures/`), Ergebnisse (`splat/runs/`),
Tools (`splat/tools/`), Build-Ordner, `.venv` und `.yappy`.
