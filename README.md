# SplatTwin

Projekt im Modul CVAI: eine Person als Gaussian Splat aufnehmen und live per Kamera-Tracking bewegen.

```
Aufnahme            Rekonstruktion                       Live-Avatar
capture.html   ──►  splattwin process                ──►  tracking.html
oder Mac-App        Video → Masken → COLMAP → Brush       Kamera → Pose → Filter → Skelett → Splat
                    → splat.ply, splat.json, rig.json     live.html: Bühne mit zwei Presentern und Folien
```

| Ordner | Inhalt |
|---|---|
| [`web/`](web/) | Seiten in TypeScript (Vite): Tracking, Aufnahme, Viewer, Bühne, Regie |
| [`python/`](python/) | Paket `splattwin`: Pipeline (Video → Splat) und lokaler Server |
| [`contracts/`](contracts/) | Datenformate zwischen den Teilen als JSON-Schema |
| [`app/`](app/) | Mac- und iPhone-App für Aufnahme und Kameras, siehe [`app/README.md`](app/README.md) |
| [`docs/`](docs/) | [Architektur](docs/architektur.md), [Konventionen](docs/konventionen.md), [Anforderungen an die App](docs/app-anforderungen.md), [Notizen zum SMPL-Avatar](docs/notizen-smpl-avatar.md) |
| `data/` | Aufnahmen, Läufe und Tools, **nicht im Repo** |

## Einrichten nach dem Klonen

Voraussetzungen (Homebrew): `uv`, `node` (ab 22), `ffmpeg`, `colmap` (getestet mit COLMAP 4.2). Für die Apps
zusätzlich Xcode 26.

```sh
brew install uv node ffmpeg colmap
make setup        # Python-Umgebung (uv sync), npm-Pakete, Seiten bauen
```

`make` allein zeigt alle Ziele.

**Python:** Alles Python-seitige teilt eine Umgebung (`.venv` im Projektordner). Die genauen Versionen
stehen in `uv.lock`; Python 3.12 ist über `.python-version` festgelegt, weil es mediapipe nur bis 3.12 gibt.
Neue Pakete mit `uv add --package splattwin <paket>`, nicht mit `pip`.

**Web:** `web/` ist ein npm-Projekt. Neue Pakete mit `npm install <paket>` in `web/`.

### Tools in data/tools/

Grosse Dateien sind nicht im Repo. Die Pipeline erwartet Brush unter
`data/tools/brush/brush-app-aarch64-apple-darwin/brush_app` (getestet mit Version 0.3.0):

```sh
mkdir -p data/tools/brush && cd data/tools/brush
curl -LO https://github.com/ArthurBrussee/brush/releases/download/v0.3.0/brush-app-aarch64-apple-darwin.tar.xz
tar -xf brush-app-aarch64-apple-darwin.tar.xz
xattr -dr com.apple.quarantine brush-app-aarch64-apple-darwin   # sonst blockiert macOS das Programm
```

Das MediaPipe-Modell (`data/tools/pose_landmarker_heavy.task`) lädt die Pipeline beim ersten Gebrauch selbst.
Mit `SPLATTWIN_DATA=<ordner>` liegt `data/` woanders.

## Starten

```sh
make serve        # Seiten bauen, Server starten: http://127.0.0.1:8931
make dev          # zum Entwickeln: Server und Vite mit Neuladen (Adresse zeigt Vite)
```

Die Startseite verlinkt alle Seiten. Die Kamera gibt Chrome nur über `127.0.0.1` oder `localhost` frei.

### Splat aus einem Video

```sh
uv run splattwin splat video.mov --bg-start 1 --bg-seconds 4 --start 8 --end 26 --height 1.80
uv run splattwin rig video
```

Ergebnis in `data/runs/video/`, ansehen mit `viewer.html?run=video`, als Avatar `tracking.html?run=video`.
Eine Aufnahme aus `capture.html` oder der App rechnet `uv run splattwin process <name>` in einem Schritt
(Splat, Kopf, Gelenke). Hinweise für gute Aufnahmen: [`docs/notizen-smpl-avatar.md`](docs/notizen-smpl-avatar.md).

### Live-Präsentation (Bühne)

Zwei Presenter als Splat (oder Roboter) und die Folien in einem 3D-Raum, live für alle Zuschauer im
Browser. Übertragen werden nur Gelenkpunkte, etwa 110 bis 360 Bytes pro Bild, kein Video.

```sh
SPLATTWIN_PW_A=… SPLATTWIN_PW_B=… uv run splattwin serve --lan   # ohne Passwörter: zufällig, im Terminal
```

| Seite | Wer | Wozu |
|---|---|---|
| `live.html` | alle | Bühne: Platz A (links, mint) und B (rechts, blau), Leinwand, Ansichten, «Folie gross» fürs Handy |
| `login.html` | Presenter | Login für Platz A oder B, nur über eine Adresse, die mit `present.` beginnt |
| `tracking.html` | Presenter | unter «Live senden» Name eintragen und «Auf die Bühne senden» einschalten |
| `control.html` | Presenter | Regie: PDF hochladen, Folien umschalten (Pfeiltasten, Klicker), Bildrate pro Presenter |

- **Am eigenen Rechner:** direkt über `127.0.0.1` darf man alles und wählt den Platz selbst. Den Login
  testen mit `http://present.localhost:8931/` (Chrome und Safari leiten `*.localhost` auf den eigenen Rechner).
- **Im Internet:** zwei Hostnamen auf denselben Server, z. B. mit einem Cloudflare-Tunnel:
  `splattwin.<domain>` für Zuschauer, `present.splattwin.<domain>` für Presenter, Server mit `--public`.
  Über HTTPS darf der Browser auf der Presenter-Adresse die Kamera benutzen, beide tracken vom eigenen Laptop.
- **Folien:** PowerPoint › Datei › Exportieren › PDF (Animationen gehen verloren). Liegt in `data/stage/`.
- **Splat vorgerechnet:** Die Tracking-Seite rechnet die Zuordnung der Kleckse zum Skelett einmal und
  speichert sie als `data/runs/<lauf>/skin.bin`; die Bühne lädt nur diese Datei (460 KB statt 2,7 MB PLY,
  kein Rechnen auf dem Handy) und den Splat schon beim Öffnen.
- **Ruckeln:** Bühne und Regie zeigen pro Presenter «B/s». Unter etwa 20: Tracking-Fenster sichtbar lassen
  (Chrome bremst verdeckte Fenster), «Finger tracken» aus, «Sparmodus beim Senden» an.

## Entwickeln

```sh
make check        # Lint, Typen, Tests (dasselbe wie die CI)
make swift-test   # Tests der App
```

Commits nach [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `refactor:`,
`test:`, `docs:`, `build:`, `ci:`, `chore:`, mit Bereich in Klammern, wo es hilft (`feat(web): …`,
`fix(python): …`).

## Was nicht ins Repo kommt

Siehe `.gitignore`: `data/` (Aufnahmen, Läufe, Tools), Bilder und Videos, `web/dist`, `node_modules`,
`.venv` und Caches.
