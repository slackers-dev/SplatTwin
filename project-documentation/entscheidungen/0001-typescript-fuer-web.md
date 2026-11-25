# 0001: Web-Teil in TypeScript mit Vite

- **Status:** angenommen
- **Datum:** 25.11.2026
- **Beteiligt:** Team

## Ausgangslage

Der Web-Teil war JavaScript ohne Build. `main.js` (etwa 40 KB) mischte Bedienung, Tracking,
Kalibrierung, Stereo und Live-Senden, die Szene war in `main.js` und `live.js` doppelt aufgebaut.
Fehler zeigten sich erst im Browser, Tests gab es kaum.

## Entscheidung

TypeScript mit Vite (mehrere Seiten), Vitest und ESLint. Die Mathematik liegt in `web/src/core` ohne DOM
und hat Tests mit synthetischen Daten. ESLint setzt die Abhängigkeitsregeln zwischen den Ordnern durch.
`strict` und `noUncheckedIndexedAccess` sind an.

## Betrachtete Alternativen

- **JavaScript behalten, nur aufteilen:** Fehlende Gelenke (`pts[i]` ist `undefined`) und falsche Formate
  fallen weiterhin erst zur Laufzeit auf.
- **TypeScript 7:** typescript-eslint 8.74 unterstützt nur TypeScript unter 6.1, darum TypeScript 6.0.

## Folgen

- Seiten müssen gebaut werden (`make web`), zum Entwickeln `make dev` mit Neuladen.
- Typen für die Datenformate kommen aus `contracts/` (siehe 0003).

## Quellen

- [`docs/projektstruktur.md`](../../docs/projektstruktur.md)
- [`docs/architektur.md`](../../docs/architektur.md), Abschnitt Web
