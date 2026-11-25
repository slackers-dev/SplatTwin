# 0006: Umbau auf einem Branch, ohne `legacy/`

- **Status:** angenommen
- **Datum:** 25.11.2026
- **Beteiligt:** Team

## Ausgangslage

Für den Neuaufbau gab es zwei Wege: alles auf einmal umbauen, oder Modul für Modul neben dem alten Code,
der dafür zuerst nach `legacy/` gezogen wird.

## Entscheidung

Alles auf einem Branch (`refactor/projektstruktur`), in kleinen Commits pro Teil. Kein `legacy/`: Der alte
Code bleibt in der Git-Historie.

## Betrachtete Alternativen

- **Modul für Modul mit `legacy/`:** zwei Fassungen nebeneinander, doppelte Pfade in der App, länger
  ein halbfertiger Zustand.

## Folgen

- Gemerged als PR #1 am 25.11.2026.
- Wer den alten Stand braucht, findet ihn vor dem Merge in der Historie von `main` (z. B. `1a557c7`).

## Quellen

- [`docs/projektstruktur.md`](../../docs/projektstruktur.md), offener Punkt 4 und «Abweichungen in der
  Umsetzung»
