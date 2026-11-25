# 0003: Datenformate als JSON-Schema in `contracts/`

- **Status:** angenommen
- **Datum:** 25.11.2026
- **Beteiligt:** Team

## Ausgangslage

Browser, App und Pipeline tauschen Dateien aus (`capture.json`, `splat.json`, `rig.json`, Live-Bilder).
Die Formate waren nur im Code festgelegt. Änderte eine Seite das Format, brach die andere still.
Zu zweit ist das die wichtigste Naht: der Lauf-Ordner zwischen Rekonstruktion und Tracking.

## Entscheidung

Jedes Format hat ein JSON-Schema in `contracts/` mit einem gültigen Beispiel. Die TypeScript-Typen werden
daraus erzeugt (`npm run gen:contracts`), Python prüft gegen dieselben Schemas. Beide Testsuiten prüfen
die Beispiele, die CI prüft, ob die erzeugten Typen aktuell sind.

Die Schemas beschreiben die Formate so, wie sie heute geschrieben werden, ohne Versionsfeld. Ein
Formatwechsel hätte Änderungen in der App verlangt, die sich ohne iPhone nicht testen liessen.

## Betrachtete Alternativen

- **Typen von Hand in TypeScript und Python:** zwei Quellen, die auseinanderlaufen.
- **Protobuf oder Ähnliches:** zu schwer für ein paar JSON-Dateien, die App schreibt bereits JSON.

## Folgen

- Formate nur über das Schema ändern, `web/src/contracts/generated.ts` nie von Hand.
- Ein Versionsfeld (`schemaVersion`) bleibt offen, bis die App ohnehin angepasst wird.

## Quellen

- [`contracts/README.md`](../../contracts/README.md)
- [`docs/projektstruktur.md`](../../docs/projektstruktur.md), Abschnitt Verträge
