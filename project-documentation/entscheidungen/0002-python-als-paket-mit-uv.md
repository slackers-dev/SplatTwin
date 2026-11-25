# 0002: Python als ein Paket in einem uv-Workspace

- **Status:** angenommen
- **Datum:** 25.11.2026
- **Beteiligt:** Team

## Ausgangslage

Die Pipeline bestand aus losen Skripten, die sich gegenseitig importierten
(`rig_splat` → `merge_head` → `splat_pipeline`). Die COLMAP-Dateien wurden mehrfach geparst.

## Entscheidung

Ein Paket `splattwin` unter `python/` mit einer CLI (`splattwin serve | process | splat | merge-head | rig`).
Der Projektordner ist ein uv-Workspace mit einer gemeinsamen `.venv` und `uv.lock`. Python 3.12, weil es
mediapipe nur bis 3.12 gibt. mediapipe und rembg sind optional (`[vision]`), damit CI und Server ohne sie
auskommen.

## Betrachtete Alternativen

- **pip mit requirements.txt:** keine festen Versionen für alle Abhängigkeiten.
- **Eigene Umgebung nur in `python/`:** Die App startet den Server über `.venv/bin/python` im
  Projektordner, das hätte Änderungen in der App verlangt.

## Folgen

- Neue Pakete nur mit `uv add --package splattwin <paket>`.
- Pipeline-Schritte importieren sich nicht gegenseitig, `process` startet jeden Schritt als eigenen
  Prozess.

## Quellen

- [`docs/projektstruktur.md`](../../docs/projektstruktur.md), Abschnitt «Abweichungen in der Umsetzung»
- [`docs/architektur.md`](../../docs/architektur.md), Abschnitt Python
