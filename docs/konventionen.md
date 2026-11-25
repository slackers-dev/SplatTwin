# Konventionen

## Koordinatensysteme

| System | Achsen | Einheit | Wo |
|---|---|---|---|
| MediaPipe-Bildpunkte (`landmarks`) | x nach rechts, y nach unten, Ursprung oben links | Anteil an Bildbreite bzw. -höhe (0..1) | Erkennung |
| MediaPipe-Weltpunkte (`worldLandmarks`) | x, y nach unten, z von der Kamera weg; Ursprung Mitte der Hüfte | Meter | Erkennung |
| Kamera | x nach rechts, y nach unten, z in Blickrichtung | Meter | `core/stereo`, `core/ekf` |
| Normierte Bildkoordinaten | n = [X/Z, Y/Z] (entzerrt) | – | Triangulation, EKF |
| Avatar (wie three.js) | x = links der Person, y oben, z zum Betrachter | Meter | `avatar/`, Live-Frame |
| COLMAP | Welt → Kamera: x_cam = R x_world + t, Zentrum C = −Rᵀt | beliebig | `io/colmap` |
| Splat-Welt (`splat.json`) | y oben, Füsse bei y = 0, Person schaut nach +z, mittig in x und z | Meter | Lauf-Ordner |

Umrechnungen:

- MediaPipe-Welt → Avatar: `[x, −y, −z]` (`core/landmarks.ts: toThree`)
- Kamera → Avatar: `[x, −y, −z]` (`camToThree`)
- Relative Pose zweier Kameras: x_B = R x_A + T, R zeilenweise als Array mit 9 Zahlen
- COLMAP → Splat-Welt: die 4×4-Matrix in `splat.json` (zeilenweise)

## Kameradaten

`fx` und `cx` beziehen sich auf die Bildbreite, `fy` und `cy` auf die Bildhöhe (Vertrag `intrinsics`).
So gelten sie für jede Auflösung desselben Bildausschnitts. Im Tracking heisst „Brennweite“ immer
`fy`, also Brennweite in Bildhöhen; ohne Kalibrierung kommt sie aus dem vertikalen Öffnungswinkel
(`focalFromFov`). Verzeichnung im OpenCV-Modell `k1, k2, p1, p2, k3`.

## Zeit

- Zeitmarken einer Aufnahme (`marks`): Sekunden im Video der Kamera a.
- `offset`: so viel später liegt ein Ereignis in Video b als in Video a.
- Im Browser: Millisekunden auf der Zeitachse von `performance.now()`. Kameras der Mac-App liefern ihre
  Aufnahmezeit umgerechnet auf diese Achse (`tracking/app-bridge.ts`).

## Namen

- Bilder eines Laufs: `<kamera>_<nnnn>.png`, der Buchstabe ist die Kamera bzw. der Abschnitt mit eigener
  Brennweite (`a`, `b`, …). `a_0000.png` ist das erste Bild, in dem die Person zur Kamera schaut.
- Gelenknamen in `rig.json`: `nose, lEar, rEar, lSh, rSh, lEl, rEl, lWr, rWr, lHip, rHip, lKn, rKn, lAn, rAn`
  (`l` = linke Seite der Person).
- Kameras: im Tracking `A` und `B`, in Aufnahmen `a` und `b`.

## Sprache

- Bezeichner (Variablen, Funktionen, Dateien) auf Englisch.
- Kommentare im Code auf Deutsch, ohne Umlaute (`ae`, `oe`, `ue`), wie bisher. Texte für Benutzer
  (Seiten, Ansagen, Meldungen) und die Doku mit Umlauten.
- Fachbegriffe wie im Modul: Kalman-Filter, Triangulation, Kameradaten (Intrinsics), Lauf (Run).

## Commits

[Conventional Commits](https://www.conventionalcommits.org) mit deutscher Beschreibung:

| Typ | Wofür |
|---|---|
| `feat` | neue Funktion |
| `fix` | Fehler behoben |
| `refactor` | Struktur geändert, Verhalten gleich |
| `test` | Tests |
| `docs` | Dokumentation |
| `build` | Abhängigkeiten, Werkzeuge, Makefile |
| `ci` | GitHub Actions |
| `chore` | Aufräumen, Verschieben |

Bereich in Klammern, wo es hilft: `web`, `python`, `app`, `contracts`. Beispiel:
`fix(web): Hand bleibt nach Verlust nicht mehr stehen`.
