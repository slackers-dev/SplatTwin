# 0004: Server mit FastAPI statt Standardbibliothek

- **Status:** angenommen
- **Datum:** 25.11.2026
- **Beteiligt:** Team

## Ausgangslage

`server.py` lief auf der Standardbibliothek und erledigte vier Aufgaben in einem Handler mit einer
if-Kette: Seiten ausliefern, Kalibrierung, Aufnahmen speichern, Live-Übertragung. Die Live-Übertragung lief
mit Threads.

## Entscheidung

FastAPI mit uvicorn. Routen als Funktionen mit Parametern, statische Dateien über `StaticFiles`, Live-Teil
mit `asyncio`. Der Zugriffsschutz (Geräte im Netz nur lesend) ist eine ASGI-Schicht (`Guard`). Fehler
bleiben `{"error": …}`, so wie die Seiten sie anzeigen.

## Betrachtete Alternativen

- **Standardbibliothek behalten, nur in Module aufteilen:** wurde zuerst gemacht, Routen, Validierung und
  Streams blieben Handarbeit.

## Folgen

- Eine Abhängigkeit mehr, dafür API-Doku unter `/api/docs` und Tests mit dem TestClient.
- Ctrl+C mit offenem Zuschauer beendet den Server ohne Abbruch.
- Grundlage für die WebSockets der Bühne.

## Quellen

- Commit `efbcd74` (refactor(python): Server auf FastAPI mit uvicorn)
- [`docs/projektstruktur.md`](../../docs/projektstruktur.md), offener Punkt 2
