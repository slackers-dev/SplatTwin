# Verlauf

Neueste Einträge oben. Pro Eintrag: Datum, was passiert ist, Links.

## 26.11.2026: LHM++ geprüft

- Code von LHM++ ist offen und nimmt mehrere Fotos: als Alternative in Entscheidung
  [0007](entscheidungen/0007-avatar-weg.md) eingetragen
- LHM, LHM++ und ExAvatar liefern kein fertig geriggtes Modell: Skinning an SMPL-X in Spark und
  SMPL-X-Posen aus dem Tracking sind bei allen Wegen selbst zu bauen

## 25.11.2026: Neuaufbau, Bühne, Drehbücher

- Projektstruktur neu aufgebaut und nach `main` gemerged (PR #1). Begründung in
  [`docs/projektstruktur.md`](../docs/projektstruktur.md), Entscheidungen 0001 bis 0006.
  - Web-Teil in TypeScript mit Vite, Vitest und ESLint, Mathematik in `web/src/core` mit Tests
  - Python als Paket `splattwin` mit einer CLI, Server auf FastAPI
  - Datenformate als JSON-Schema in `contracts/`
  - Makefile als gemeinsamer Einstieg, CI auf GitHub Actions
- Bühne mit zwei Presentern, Folien, Regie und Presenter-Login (`feat/buehne`)
- Drehbücher für Aufnahmen mit Brush und ExAvatar (PR #2):
  [`docs/drehbuch-brush.md`](../docs/drehbuch-brush.md),
  [`docs/drehbuch-exavatar.md`](../docs/drehbuch-exavatar.md)
- Recherche zu Splat-Bibliotheken: Spark bleibt der Renderer, LHM und HumanGS als mögliche
  Alternativen zu ExAvatar notiert (siehe Entscheidung 0007)
- Logo und App-Icons

## 20.11.2026: Erster Stand und Ursache der unscharfen Splats

- Erster Commit: Web-Viewer, Splat-Pipeline, Mac- und iPhone-App
- Live-Avatar mit Roboter-Overlay, Nur-Oberkörper-Modus und Live-Übertragung
- Neue App-Aufnahmen wurden unschärfer als das erste Handy-Video. Ursache: zu lange Drehung, die Person
  ist nicht starr. Regeln für starre Aufnahmen und Plan für den SMPL-Weg in
  [`docs/notizen-smpl-avatar.md`](../docs/notizen-smpl-avatar.md)
- Aufnahme mahnt zu langsame Drehung an, Pipeline-Option `--focal` (noch nicht automatisch aktiv)
