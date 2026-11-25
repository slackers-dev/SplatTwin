# CLAUDE.md

SplatTwin (Modul CVAI): eine Person als Gaussian Splat aufnehmen und live per Kamera-Tracking bewegen.
Überblick und Einrichtung in [`README.md`](README.md).

## Wo was steht

| Datei | Inhalt |
|---|---|
| [`README.md`](README.md) | Überblick, Einrichten, Starten, Pipeline |
| [`docs/architektur.md`](docs/architektur.md) | Datenfluss, Module, Server-Routen, **Abhängigkeitsregeln**, Tests |
| [`docs/konventionen.md`](docs/konventionen.md) | Beitragsregeln: Koordinatensysteme, Einheiten, Namen, Sprache, Commits |
| [`contracts/README.md`](contracts/README.md) | Datenformate zwischen den Teilen |
| [`app/README.md`](app/README.md) | Mac- und iPhone-App |
| [`project-documentation/`](project-documentation/) | Verlauf und Entscheidungen des Projekts |

Vor Änderungen an einem Teil den passenden Abschnitt in `docs/architektur.md` lesen.

## Befehle

```sh
make setup        # uv sync, npm ci, Seiten bauen
make serve        # Seiten bauen, Server auf http://127.0.0.1:8931
make dev          # Server und Vite mit Neuladen
make check        # Lint, Format, Typen, Verträge, Tests (wie die CI)
make swift-test   # Tests der App

uv run pytest python/tests/test_stage.py   # einzelne Python-Tests
cd web && npx vitest run src/core           # einzelne Web-Tests
```

Vor jedem Commit `make check`.

## Regeln

- **Abhängigkeiten zwischen Modulen** wie in `docs/architektur.md`. Im Web setzt ESLint sie durch,
  `web/src/core` kennt kein DOM. In Python importieren sich die Pipeline-Schritte nicht gegenseitig.
- **Datenformate nur über `contracts/`:** Schema und Beispiel ändern, dann `cd web && npm run gen:contracts`.
  `web/src/contracts/generated.ts` nie von Hand ändern.
- **Ausgabe der Pipeline** (z. B. `Registriert: X von Y Frames`) liest die Mac-App mit. Nur zusammen mit
  `app/Kit/Sources/SplattwinKit/CaptureStore.swift` ändern.
- **Pakete:** Python mit `uv add --package splattwin <paket>`, nie pip. Web mit `npm install` in `web/`.
  Python bleibt 3.12 (mediapipe), TypeScript bleibt 6.0 (typescript-eslint).
- **Sprache:** Bezeichner Englisch. Kommentare Deutsch ohne Umlaute. Doku und Texte für Benutzer Deutsch
  mit Umlauten, Schweizer Schreibweise (ss statt ß).
- **Commits:** Conventional Commits mit deutscher Beschreibung und Bereich, z. B.
  `fix(web): Hand bleibt nach Verlust nicht mehr stehen`. Auf einem Branch arbeiten, nicht direkt auf `main`.
- **Nicht ins Repo:** `data/` (Aufnahmen, Läufe, Brush, Modelle), Bilder, Videos, `.ply`.
- **Entscheidungen** (Bibliothek, Verfahren, Format) als Dokument in
  `project-documentation/entscheidungen/` festhalten, Vorlage dort. Grössere Schritte in
  `project-documentation/verlauf.md` eintragen.

## Hinweise

- Die Kamera gibt Chrome nur über `127.0.0.1` oder `localhost` frei.
- Ohne Kamera testen: `tracking.html?src=<video>`, `capture.html?srcA=<video>`.
- Die Pipeline braucht Brush in `data/tools/` (siehe README), Server und Tests nicht.
