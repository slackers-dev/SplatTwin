# Saubere Projektstruktur für den Neuaufbau

**Status:** umgesetzt am 25.11.2026 auf dem Branch `refactor/projektstruktur`, mit den Abweichungen unten.
Der heutige Aufbau steht in [`architektur.md`](architektur.md); dieses Dokument bleibt als Begründung.

## Abweichungen in der Umsetzung

- **Formate unverändert.** Die Schemas in `contracts/` beschreiben die Dateien so, wie Browser, App und
  Pipeline sie heute schreiben (ohne `schemaVersion`, `capture.json` mit `saved` und `height`). Ein
  Formatwechsel hätte mehr Änderungen in der App verlangt, als sich ohne iPhone testen lassen.
  Die Punkte unter „Auswirkungen auf die App“ zur Metadatei entfallen damit.
- **Server ohne FastAPI.** Der Server ist in Module aufgeteilt (`calibration`, `captures`, `live`, `app`),
  läuft aber weiter mit der Standardbibliothek. FastAPI bleibt offener Punkt 2.
- **Python als uv-Workspace.** `python/` ist ein Mitglied, der Projektordner der Workspace mit der
  gemeinsamen `.venv`. So startet die App den Server weiter über `.venv/bin/python`.
- **Kein `legacy/`.** Der alte Code ist in der Git-Historie (`main`).
- **`core` mit `noUncheckedIndexedAccess: false`.** Matrizen und Vektoren fester Grösse; in der App bleibt
  das Flag an.
- **Seiten:** `tracking.html` (vorher `index.html`), `viewer.html` (vorher `splat.html`), neu eine
  Startseite `index.html`.
- **Noch nicht angelegt:** `docs/arbeitspakete.md`, `docs/entscheide/`.
- **CI ohne Swift:** die App-Tests laufen lokal (`make swift-test`).

## Warum

Das Projekt ist als Prototyp gewachsen und funktioniert. Für die Weiterarbeit zu zweit stören aber ein paar Dinge:

| Heute | Folge |
|---|---|
| `main.js` (~40 KB) mischt UI, Tracking, Kalibrierung, Stereo und Live-Senden | Schwer zu testen, zu zweit gleichzeitig kaum zu bearbeiten |
| Die Szene ist in `main.js` und `live.js` doppelt aufgebaut | Änderungen müssen zweimal gemacht werden |
| Python-Skripte importieren sich gegenseitig (`rig_splat` → `merge_head` → `splat_pipeline`), die COLMAP-Textdateien werden mehrfach geparst | Unklare Abhängigkeiten, doppelter Code |
| `server.py` erledigt vier Aufgaben in einem Handler | Schwer zu erweitern |
| Datenformate (`capture.json`, `splat.json`, `rig.json`, Live-Frame) sind nur implizit im Code festgelegt | Bricht still, wenn eine Seite das Format ändert |
| Kaum Tests ausserhalb der App, JavaScript ohne Typen | Fehler zeigen sich erst im Browser |

Ziel: klare Module mit festen Grenzen, Formate als Verträge, TypeScript statt JavaScript, Tests für die gesamte Mathematik.

## Struktur

```
SplatTwin/
├── README.md                  Überblick, Schnellstart, wer macht was
├── Makefile                   make dev | make test | make lint (ein Einstieg für beide Hälften)
├── .github/workflows/ci.yml   Lint und Tests für web/ und python/
│
├── docs/
│   ├── architektur.md         Datenfluss, Module, Abhängigkeitsregeln
│   ├── konventionen.md        Koordinatensysteme (MediaPipe, three.js, Kamera, COLMAP), Einheiten
│   ├── arbeitspakete.md
│   ├── app-anforderungen.md   (heute APP_ANFORDERUNGEN.md)
│   ├── notizen-smpl-avatar.md (heute NOTIZEN_SMPL_AVATAR.md)
│   └── entscheide/            0001-typescript.md, 0002-avatar-weg.md, …
│
├── contracts/                 ★ Einzige Quelle der Wahrheit für alle Datenformate
│   ├── capture.schema.json      Aufnahme-Metadaten     (Aufnahme → Pipeline)
│   ├── run-splat.schema.json    Ausrichtung splat.json (Pipeline → Avatar)
│   ├── run-rig.schema.json      Gelenke rig.json       (Pipeline → Avatar)
│   ├── intrinsics.schema.json   Kameradaten            (Kalibrierung/App → Tracking)
│   ├── live-frame.schema.json   Live-Bild              (Tracking → Zuschauer)
│   └── examples/                je ein gültiges Beispiel, beide Testsuiten prüfen es
│
├── web/                       TypeScript, Vite, Vitest
│   ├── package.json
│   ├── tsconfig.json          Projekt-Referenzen: core (ohne DOM) + app
│   ├── vite.config.ts         Mehrere Seiten; /api und /runs an den Python-Server weiterleiten
│   ├── eslint.config.js       erzwingt die Abhängigkeitsregeln (siehe unten)
│   ├── index.html  tracking.html  capture.html  viewer.html  live.html
│   ├── public/models/Xbot.glb
│   └── src/
│       ├── core/              ★ reine Mathematik: kein DOM, kein three.js, kein MediaPipe
│       │   ├── tsconfig.json    lib: ES2023 ohne DOM → Verstösse fallen beim Kompilieren auf
│       │   ├── vec.ts  mat3.ts
│       │   ├── kalman.ts        Constant-Velocity-Filter
│       │   ├── ekf.ts           Kamera-Fusion
│       │   ├── stereo.ts        relative Pose, Triangulation
│       │   ├── root.ts          Position im Raum (Lochkamera)
│       │   ├── turn.ts          Drehwinkel aus der Schulterlinie
│       │   ├── landmarks.ts     MediaPipe-Indizes, Knochenliste
│       │   └── *.test.ts        Tests mit synthetischen Daten
│       ├── contracts/         aus contracts/ erzeugte Typen (npm run gen:contracts)
│       ├── tracking/          Browser: Kameras und Erkennung
│       │   ├── camera-source.ts   Schnittstelle: Webcam | Videodatei | App-Kamera
│       │   ├── webcam.ts  video-file.ts  app-bridge.ts
│       │   ├── pose-detector.ts   MediaPipe Pose und Hände → Messung
│       │   ├── calibration.ts     Schachbrett über den Server
│       │   └── tracker.ts         Quellen → Messung → Filter → Pose (ohne UI)
│       ├── avatar/            three.js
│       │   ├── scene.ts           gemeinsame Szene (heute doppelt in main.js/live.js)
│       │   ├── robot.ts  retarget.ts  splat-avatar.ts
│       ├── capture/           geführte Aufnahme
│       │   ├── flow.ts            Zustandsmaschine (wie Flow.swift)
│       │   └── recorder.ts
│       ├── live/              sender.ts, receiver.ts (SSE)
│       ├── ui/                kleine Panel-Helfer
│       └── pages/             je Seite eine dünne main.ts, die nur zusammensteckt
│           ├── tracking/  capture/  viewer/  live/
│
├── python/                    uv-Projekt, ein Paket statt loser Skripte
│   ├── pyproject.toml         Kern: numpy, opencv, jsonschema, fastapi
│   │                          optional [vision]: mediapipe, rembg (schwer, CI braucht es nicht)
│   ├── src/splattwin/
│   │   ├── cli.py             splattwin process | frames | masks | sfm | train | align | rig | merge-head | serve
│   │   ├── config.py          Pfade: data/, tools/ (Brush, Modelle), über Umgebungsvariable änderbar
│   │   ├── contracts.py       JSON lesen und schreiben mit Prüfung gegen contracts/
│   │   ├── io/                colmap.py (einmal statt dreimal parsen), ply.py, video.py
│   │   ├── geometry/          triangulate.py, umeyama.py, camera.py
│   │   ├── vision/            landmarks.py (MediaPipe), segmentation.py (rembg, bgdiff)
│   │   ├── pipeline/          frames, masks, sfm, train, align, rig, merge_head, process
│   │   └── server/            app.py + Routen: calibration, captures, live, statische Dateien
│   └── tests/
│
├── app/                       Swift, bleibt wie heute (nur Pfade und Format anpassen)
│
└── data/                      nicht im Repo
    ├── captures/  runs/  tools/
```

## Abhängigkeitsregeln

```
pages ──► tracking ──► core ◄── avatar ◄── pages
  │          │          ▲         │
  └──► live ─┴─► contracts ◄──────┘
```

- **`core`** importiert nichts ausser sich selbst und `contracts`. Die eigene `tsconfig` ohne DOM erzwingt das schon beim Kompilieren.
- **`tracking`** und **`avatar`** kennen sich nicht. Sie verbinden sich nur über Typen (`Pose`, `LiveFrame`). Das ist zugleich die Grenze zwischen den beiden Hälften der Arbeit.
- **`pages`** steckt nur zusammen und enthält keine Logik.
- In Python dürfen `pipeline` und `server` auf `io`, `geometry` und `vision` zugreifen, aber nie umgekehrt. Die Schritte der Pipeline importieren sich nicht gegenseitig.

ESLint (`no-restricted-imports` pro Ordner) prüft die Regeln im Web-Teil, im Python-Teil übernimmt das z. B. `import-linter`.

## Verträge

Jedes Datenformat zwischen zwei Teilen ist ein JSON-Schema in `contracts/`:

- TypeScript-Typen werden daraus erzeugt (`json-schema-to-typescript`), sie werden nicht von Hand geschrieben.
- Python prüft Dateien beim Lesen und Schreiben mit `jsonschema`.
- Jedes Schema hat ein Beispiel in `contracts/examples/`, beide Testsuiten prüfen es.
- Ein Schema wird nur zusammen mit dem Beispiel und beiden Seiten geändert. Bei einer inkompatiblen Änderung wird `schemaVersion` erhöht.

Der Lauf-Ordner, also die Schnittstelle zwischen Rekonstruktion und Avatar:

```
data/runs/<lauf>/
  splat.ply      Gaussian Splat in COLMAP-Koordinaten (wie Brush ihn schreibt)
  splat.json     Matrix COLMAP → Welt (Meter, y oben, Füsse bei y = 0, Person schaut nach +z)
  rig.json       Gelenke der Person in Weltkoordinaten
  report.json    Qualitätsbericht der Pipeline (nicht Teil des Vertrags)
  work/          Zwischenstände (Bilder, Masken, COLMAP), darf gelöscht werden
```

## Was wohin wandert

| Heute | Neu |
|---|---|
| `kalman.js`, `ekf.js`, `stereo.js` | `web/src/core/` (fast 1:1, jetzt mit Typen und Tests) |
| `main.js` | aufgeteilt auf `tracking/tracker.ts`, `tracking/calibration.ts`, `live/sender.ts`, `pages/tracking/` |
| `retarget.js`, `splat-avatar.js`, Szene aus `main.js`/`live.js` | `web/src/avatar/` |
| `capture.html` (Inline-Script) | `capture/flow.ts` + `pages/capture/` |
| `splat.html` | `viewer.html` + `pages/viewer/` |
| `live.html`, `live.js` | `live.html` + `live/receiver.ts` + `pages/live/` |
| `app-kamera.js` | `tracking/app-bridge.ts` (als `CameraSource`) |
| `splat/splat_pipeline.py` (445 Zeilen) | `pipeline/frames.py`, `masks.py`, `sfm.py`, `train.py`, `align.py` |
| `merge_head.py`, `rig_splat.py` | `geometry/` (Triangulation, Umeyama) + `pipeline/merge_head.py`, `rig.py` |
| `process_capture.py` | `splattwin process <aufnahme>` |
| `server.py` | `python/src/splattwin/server/` (FastAPI, getrennte Routen) |
| `splat/captures`, `splat/runs`, `splat/tools` | `data/…` |
| `models/Xbot.glb`, `schachbrett.png` | `web/public/` |

## Werkzeuge

- **TypeScript 6.0**, nicht 7: typescript-eslint (8.74) unterstützt TypeScript 7 noch nicht. Mit `strict` und `noUncheckedIndexedAccess`, das fängt fehlende Gelenke (`pts[i]` ist `undefined`) schon beim Kompilieren.
- **Vite** für Dev-Server und Build, **Vitest** für Tests. three.js, MediaPipe und Spark kommen über npm statt über eine Importmap aus dem CDN.
- **uv** mit `ruff` und `pytest` für Python. Die schweren Pakete (mediapipe, rembg) liegen in einer optionalen Gruppe, damit Tests und CI schnell bleiben.
- **Entwickeln:** Vite-Dev-Server für die Seiten, Python-Server für `/api` und `/runs`. Vite leitet diese Pfade weiter, so laufen beide wie ein einziger Server.

## Aufteilung

Die natürliche Naht ist der Lauf-Ordner: Auf der einen Seite entsteht der Splat, auf der anderen wird er bewegt. Beide können sofort mit Testdaten aus dem alten Projekt arbeiten, ohne aufeinander zu warten.

- **Rekonstruktion:** `python/` (ohne Server-Live), `web/src/capture/`, `contracts/capture` und `run-*`
- **Tracking und Avatar:** `web/src/core/`, `tracking/`, `avatar/`, `live/`, `python/src/splattwin/server/`, `contracts/intrinsics` und `live-frame`
- **Gemeinsam:** `contracts/` (Änderungen nur zu zweit), `docs/konventionen.md`, Gerüst und CI

## Auswirkungen auf die App

Die App wird nicht neu gebaut, `SplattwinKit` ist schon sauber aufgeteilt und getestet. Anzupassen wären:

- Pfade in `CaptureStore.swift`: `splat/captures` → `data/captures`, `splat/runs` → `data/runs`; die Prüfung auf `splat/process_capture.py` entfällt
- Pipeline-Aufruf in `AppModel.swift`: `uv run process_capture.py …` → `splattwin process …`
- Metadatei nach `capture.schema.json` (u. a. `schemaVersion`, `videos` statt `saved`, `heightM`)
- Seitennamen beim Öffnen im Browser (`index.html` → `tracking.html`, `splat.html` → `viewer.html`)

## Offene Punkte für die Review

1. **Avatar-Weg:** Bleibt es beim starren Splat mit Roboter-Gewichten, oder geht es auf SMPL-X/ExAvatar (siehe `notizen-smpl-avatar.md`)? Beim SMPL-Weg fallen `rig.py`, `merge_head.py` und das Roboter-Skinning weitgehend weg. Dieser Entscheid sollte vor dem Umbau fallen.
2. **Server:** FastAPI statt Standardbibliothek. Das bringt eine Abhängigkeit mehr, dafür Routen, Validierung und SSE ohne Handarbeit.
3. **Sprache im Code:** Vorschlag: Bezeichner auf Englisch (wie heute schon meistens), Kommentare und Doku auf Deutsch.
4. **Umzug:** Alles auf einmal auf einem Branch, oder Modul für Modul neben dem alten Code (alter Code zuerst nach `legacy/`)?
5. **Aufteilung:** Wer übernimmt welche Hälfte?
