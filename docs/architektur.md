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
              WebSocket /ws/send (binär, live/protocol.ts; contracts/live-frame, stage-meta)
                                   ▼
            ┌──────────────── Bühne ─────────────────────┐
            │ server/stage.py: letzter Stand je Platz A/B, Folien  │
            └──────────────────────┬───────────────────┘
                     WebSocket /ws/stage (+ contracts/stage-slides)
                                   ▼
        web: live.html (Bühne für alle)   control.html (Regie: Folien)
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
| `WS /ws/send?slot=A` | Tracking-Seite: Bilder binär, Name und Lauf als Text | `live-frame` (binär), `stage-meta` |
| `WS /ws/stage` | Bühne und Regie: Folien, Plätze, Bilder mit Platz-Byte | `stage-slides`, `stage-meta`, `live-frame` |
| `POST /api/slides?name=…` | Folien als PDF hochladen | `stage-slides` |
| `POST /api/slide` | `{page}` umschalten oder `{pages}` melden | `stage-slides` |
| `GET /stage/slides.pdf?v=<doc>` | das PDF | |
| `POST /api/skin?run=…`, `GET /runs/<lauf>/skin.bin` | vorgerechneter Splat (`avatar/skin-cache.ts`) | |
| `POST /api/login`, `POST /api/logout` | Presenter-Login (nur über `present.<Adresse>`) | |
| `GET /api/info` | Adressen im WLAN, Anzahl Zuschauer, eigener Platz | |

Wer was darf, steht in `server/access.py`, durchgesetzt von `Guard` in `server/app.py` (für HTTP und
WebSockets): dieser Rechner alles; Presenter nach dem Login über eine Adresse, die mit `present.` beginnt,
alles ausser Aufnahmen speichern, und sie senden immer auf ihrem eigenen Platz; alle anderen nur, was
`REMOTE_ALLOWED` erlaubt (Bühne, ihre Dateien, fertige Läufe, Folien-PDF), nur lesend. Ein Tunnel kommt
zwar auch von 127.0.0.1, zählt aber wegen seiner Weiterleitungs-Header und des fremden Hostnamens nicht als
dieser Rechner. Fehler kommen immer als `{"error": "…"}` zurück, so wie die Seiten sie anzeigen.

Caching (`cache_control` in `app.py`): Vite-Dateien unter `/assets/` (mit Hash im Namen) ein Jahr, Modelle
und das Folien-PDF einer Fassung (`?v=`) einen Tag, Seiten und Läufe mit Nachfrage (304), API und
WebSockets nie. Hinter Cloudflare kommen die grossen Dateien so aus dem Cache statt von diesem Rechner.

Die Bühne (`server/stage.py`) läuft mit `asyncio`: Pro Kanal (Platz A, B, Plätze, Folien) zählt nur der
neueste Stand, ein langsamer Zuschauer bekommt nur weniger Bilder statt einer wachsenden Verzögerung. Der
Server liest die Bilder nicht, er prüft nur ihre Länge (`frame_ok`). Folien und Plätze liegen in
`data/stage/` und überleben einen Neustart, damit die Bühne die Splats schon beim Öffnen laden kann. Beim
Beenden schliesst der Server zuerst alle Zuschauer-Streams, damit uvicorn ohne Abbruch herunterfährt.
OpenCV-Arbeit (Kalibrierung) und ffmpeg laufen in einem Thread-Pool, damit der Live-Teil nicht stockt.

## Web (`web/src`)

| Ordner | Aufgabe | Darf benutzen |
|---|---|---|
| `core/` | reine Mathematik: Kalman, EKF, Stereo, Rektifizierung und Genauigkeit, Messung, Hände, Drehwinkel, Überblendung von Live-Bildern | nur `contracts` |
| `contracts/` | aus `contracts/*.schema.json` erzeugte Typen | – |
| `tracking/` | Kameras, MediaPipe, Tracker, Kalibrierung, Brücke zur App | `core`, `contracts`, `ui` |
| `avatar/` | three.js: Szene, Roboter, Retargeting, Splat-Skinning (Roboter-Skelett mit `skin.bin`, oder SMPL-X bei Avataren von LHM++), Raum der Bühne, Presenter | `core`, `contracts`, `live` (Typen) |
| `capture/` | geführte Aufnahme: Pose prüfen, Ablauf, Rekorder, Ansage | `core`, `contracts`, `ui` |
| `live/` | Binärformat der Live-Bilder, senden und empfangen über WebSockets | `core`, `contracts` |
| `slides/` | Folien-PDF laden und Seiten zeichnen (pdf.js) | – |
| `ui/` | kleine Helfer für die Seiten (DOM, localStorage) | – |
| `pages/` | eine `main.ts` pro Seite: verdrahtet Bedienelemente und Module | alles |

Die Regeln setzt ESLint durch (`no-restricted-imports` in `web/eslint.config.js`). `core` hat zusätzlich
ein eigenes TypeScript-Projekt ohne DOM: ein Zugriff auf `window` oder ein Videoelement scheitert dort
schon beim Kompilieren. `tracking` und `avatar` kennen sich nicht; Punkte gehen als `Vec3` (Arrays)
von `tracking` zur Seite und werden dort mit `avatar/points.ts` zu three.js-Vektoren.

**Splat-Avatar.** `avatar/splat-avatar.ts` hängt einen Splat an das getrackte Skelett. Hat der Lauf eine
`smplx.json` (Avatar von LHM++), übernimmt `avatar/smplx-avatar.ts`: Es baut das SMPL-X-Skelett mit den
Namen des Mixamo-Skeletts und verformt jeden Klecks mit den Gewichten von LHM++ (`smplx_skin.bin`). Das
Skelett hängt als Mitläufer am Retargeter des Roboters (`Retargeter.followers`) und bekommt dieselben
Punkte; Seiten und Bühne rufen weiter nur den Roboter auf. Ohne `smplx.json` gilt der alte Weg: Kleckse
auf die Glieder des Roboters legen und dessen Gewichte übernehmen.

**Höhe.** `core/measure.ts` misst die Höhe der Hüfte aus dem Kamerabild (auch ohne Hüfte im Bild),
`core/height.ts` macht daraus die Höhe relativ zum Stehen (`TrackFrame.height`, im Live-Bild `height`).
`Retargeter.apply(P, hands, { height })` stellt die Figur auf diese Höhe und knickt die Beine mit
Zwei-Knochen-IK, damit die Füsse auf dem Boden bleiben. Ohne Höhe gilt: tiefster Fuss auf dem Boden.
Nullpunkt im Raum und Höhenbezug entstehen erst, wenn die Messung ruhig ist (`core/settle.ts`).
Entscheidung 0011.

**Tracker.** `tracking/tracker.ts` enthält den Ablauf pro Bild ohne Bedienelemente: Die Seite ruft pro
Animationsbild `stepB()` und `stepA()` mit den aktuellen Einstellungen auf und bekommt Messung, gefilterte
Gelenke, Position und Kennzahlen zurück. Was damit geschieht (Avatar, Vorschau, Live senden, Status),
entscheidet die Seite.

**Erkennung.** `tracking/detection.ts` (`CameraDetector`) rechnet MediaPipe je Kamera: Kamera A im
Hauptstrang (liest das Videobild ohne Kopie), Kamera B in einem Hintergrund-Strang
(`tracking/detect-worker.ts`, klassischer Worker, weil MediaPipe `importScripts` braucht). So rechnen
beide gleichzeitig. Beide im Hintergrund war langsamer, weil sie sich um die GPU streiten. Startet der
Worker nicht, rechnet die Kamera im Hauptstrang. Umstellen zum Vergleichen: `?detA=` / `?detB=`
`inline | worker | cpu`, Modell je Kamera mit `?poseA=` / `?poseB=` `lite | full | heavy` (B: heavy).
Nach Kalman bzw. EKF glättet ein One-Euro-Filter (`core/one-euro.ts`) adaptiv.

## Python (`python/src/splattwin`)

| Paket | Aufgabe |
|---|---|
| `io/` | COLMAP-Modelle und PLY-Dateien lesen und schreiben |
| `geometry/` | Triangulation aus vielen Sehstrahlen, Umeyama, Quaternionen |
| `vision/` | MediaPipe-Körperpunkte (in 3D trianguliert), Freistellen mit rembg und Hintergrundbild |
| `pipeline/` | ein Modul pro Schritt: `frames`, `dataset`, `sfm`, `train`, `align`, `rig`, `merge_head`; `splat` und `process` setzen sie zusammen |
| `server/` | `calibration`, `captures`, `stage` (Bühne), `access` (Login, wer darf was), `network`, `app` (FastAPI) |
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
| `web/src/core`, `web/src/live` | synthetische Daten mit bekannter Lösung (Stereo-Kalibrierung, EKF mit zwei Kameras, …), Binärformat, Überblendung | `npm test` |
| `python` | Geometrie, Ausrichtung, Schachbrett mit bekannter Brennweite, Server, Bühne (Login, Tunnel, WebSockets), Verträge | `uv run pytest python` |
| `contracts` | jedes Beispiel passt zu seinem Schema, in Web und Python | beide oben |
| `app/Kit` | Verbindung, Uhren, Ablauf, Metadatei | `make swift-test` |

Die Seiten selbst haben keine automatischen Tests; sie lassen sich mit `?src=<video>` (Tracking) bzw.
`?srcA=<video>` (Aufnahme) ohne Kamera ausprobieren.
