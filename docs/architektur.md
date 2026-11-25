# Architektur

## Datenfluss

```
            ┌──────────────── Aufnahme ────────────────┐
            │ web: capture.html   oder   app/ (Mac+iPhone) │
            └──────────────────────┬───────────────────┘
                     data/captures/<name>.json + Videos      (contracts/capture)
                                   ▼
            ┌──────────────── Rekonstruktion ───────────┐
            │ python: splattwin process                  │
            │ frames → masks → COLMAP → Brush → align → rig │
            └──────────────────────┬───────────────────┘
               data/runs/<lauf>/splat.ply, splat.json, rig.json   (contracts/run-*)
                                   ▼
            ┌──────────────── Live-Avatar ──────────────┐
            │ web: tracking.html                         │
            │ Kamera → MediaPipe → Messung → Filter      │
            │        → Retargeting → Splat-Skinning      │
            └──────────────────────┬───────────────────┘
                     POST /api/live (contracts/live-frame)
                                   ▼
                  web: live.html (Zuschauer, auch im WLAN)
```

Die Naht zwischen Rekonstruktion und Avatar ist der Lauf-Ordner. Beide Seiten lassen sich getrennt
entwickeln und testen: die Tracking-Seite mit einem vorhandenen Lauf, die Pipeline mit vorhandenen
Aufnahmen.

## Prozesse und Ports

| Was | Wo | Port |
|---|---|---|
| Server (`uv run splattwin serve`, FastAPI mit uvicorn) | liefert `web/dist` und `data/runs`, API | 8931 |
| Vite (`npm run dev` in `web/`) | nur beim Entwickeln, leitet `/api` und `/runs` an 8931 weiter | 5173 |
| Brücke der Mac-App | WebSocket, Kameras der App für den Browser | 8932 |

### API des Servers

Interaktive Doku im Browser: `http://127.0.0.1:8931/api/docs` (nur auf diesem Rechner).

| Methode, Pfad | Zweck | Vertrag |
|---|---|---|
| `GET /runs/<lauf>/…` | Dateien eines Laufs | `run-splat`, `run-rig` |
| `POST /api/chessboard?cam=A&reset=1` | ein Bild des Schachbretts | |
| `POST /api/calibrate?cam=A` | Kameradaten aus den gesammelten Bildern | `intrinsics` |
| `POST /api/capture?name=…&cam=a&kind=mp4\|webm\|json&rot=…` | Aufnahme speichern | `capture` (bei `kind=json`) |
| `POST /api/live` | Bild der Tracking-Seite | `live-frame` |
| `GET /api/live` | Server-Sent Events für Zuschauer | `live-frame` |
| `GET /api/info` | Adressen im WLAN, Anzahl Zuschauer | |

Geräte im Netz (mit `--lan`) bekommen nur die Zuschauerseite, ihre Dateien und die fertigen Läufe, und
nur lesend (`Guard` und `REMOTE_ALLOWED` in `python/src/splattwin/server/app.py`). Fehler kommen immer als
`{"error": "…"}` zurück, so wie die Seiten sie anzeigen.

Die Weiterleitung an Zuschauer (`server/live.py`) läuft mit `asyncio`: Jeder Zuschauer wartet auf das
nächste Bild, ein langsamer bekommt nur weniger Bilder statt einer wachsenden Verzögerung. Beim Beenden
schliesst der Server zuerst alle Zuschauer-Streams, damit uvicorn ohne Abbruch herunterfährt.
OpenCV-Arbeit (Kalibrierung) und ffmpeg laufen in einem Thread-Pool, damit der Live-Teil nicht stockt.

## Web (`web/src`)

| Ordner | Aufgabe | Darf benutzen |
|---|---|---|
| `core/` | reine Mathematik: Kalman, EKF, Stereo, Messung, Hände, Drehwinkel | nur `contracts` |
| `contracts/` | aus `contracts/*.schema.json` erzeugte Typen | – |
| `tracking/` | Kameras, MediaPipe, Tracker, Kalibrierung, Brücke zur App | `core`, `contracts`, `ui` |
| `avatar/` | three.js: Szene, Roboter, Retargeting, Splat-Skinning | `core`, `contracts` |
| `capture/` | geführte Aufnahme: Pose prüfen, Ablauf, Rekorder, Ansage | `core`, `contracts`, `ui` |
| `live/` | Live-Frames senden und empfangen | `core`, `contracts` |
| `ui/` | kleine Helfer für die Seiten (DOM, localStorage) | – |
| `pages/` | eine `main.ts` pro Seite: verdrahtet Bedienelemente und Module | alles |

Die Regeln setzt ESLint durch (`no-restricted-imports` in `web/eslint.config.js`). `core` hat zusätzlich
ein eigenes TypeScript-Projekt ohne DOM: ein Zugriff auf `window` oder ein Videoelement scheitert dort
schon beim Kompilieren. `tracking` und `avatar` kennen sich nicht; Punkte gehen als `Vec3` (Arrays)
von `tracking` zur Seite und werden dort mit `avatar/points.ts` zu three.js-Vektoren.

**Tracker.** `tracking/tracker.ts` enthält den Ablauf pro Bild ohne Bedienelemente: Die Seite ruft pro
Animationsbild `stepB()` und `stepA()` mit den aktuellen Einstellungen auf und bekommt Messung, gefilterte
Gelenke, Position und Kennzahlen zurück. Was damit geschieht (Avatar, Vorschau, Live senden, Status),
entscheidet die Seite.

## Python (`python/src/splattwin`)

| Paket | Aufgabe |
|---|---|
| `io/` | COLMAP-Modelle und PLY-Dateien lesen und schreiben |
| `geometry/` | Triangulation aus vielen Sehstrahlen, Umeyama, Quaternionen |
| `vision/` | MediaPipe-Körperpunkte (in 3D trianguliert), Freistellen mit rembg und Hintergrundbild |
| `pipeline/` | ein Modul pro Schritt: `frames`, `dataset`, `sfm`, `train`, `align`, `rig`, `merge_head`; `splat` und `process` setzen sie zusammen |
| `server/` | `calibration`, `captures`, `live`, `network`, `app` (FastAPI) |
| `contracts.py` | Prüfung gegen `contracts/` |
| `paths.py` | Orte im Projektordner (`data/`, Tools) |
| `cli.py` | `splattwin serve \| process \| splat \| merge-head \| rig` |

Abhängigkeiten nur in eine Richtung: `pipeline` und `server` benutzen `io`, `geometry` und `vision`, nie
umgekehrt. Die Schritte der Pipeline importieren sich nicht gegenseitig. `process` startet jeden Schritt
als eigenen Prozess (`python -m splattwin …`), damit ein fehlgeschlagener Kopf-Scan die Aufnahme nicht
abbricht und der Speicher freigegeben wird.

Die Ausgabe der Pipeline liest die Mac-App mit (`QualityReport` in
`app/Kit/Sources/SplattwinKit/CaptureStore.swift`): Zeilen wie `Registriert: X von Y Frames` nur
zusammen mit der App ändern.

## Tests

| Teil | Wie | Befehl |
|---|---|---|
| `web/src/core` | synthetische Daten mit bekannter Lösung (Stereo-Kalibrierung, EKF mit zwei Kameras, …) | `npm test` |
| `python` | Geometrie, Ausrichtung, Schachbrett mit bekannter Brennweite, Server, Verträge | `uv run pytest python` |
| `contracts` | jedes Beispiel passt zu seinem Schema, in Web und Python | beide oben |
| `app/Kit` | Verbindung, Uhren, Ablauf, Metadatei | `make swift-test` |

Die Seiten selbst haben keine automatischen Tests; sie lassen sich mit `?src=<video>` (Tracking) bzw.
`?srcA=<video>` (Aufnahme) ohne Kamera ausprobieren.
