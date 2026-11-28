# Notizen: Zwei-Kamera-Tracking, Rektifizierung, ruhigeres und schnelleres Tracking

Stand 27.11.2026. Erkenntnisse aus einer Sitzung zum Tracking mit Webcam (Kamera A) und iPhone
(Kamera B). Die Entscheidung zur Rektifizierung steht in
[Entscheidung 0010](../project-documentation/entscheidungen/0010-rektifizierung-als-messwerkzeug.md).

## Ausgangsfrage

Aus der Vorlesung (3DRecon 2 und 3): Zwei Kameras, die nicht parallel stehen, lassen sich rechnerisch
so drehen, als stünden sie parallel (Rektifizierung). Dazu kommen neuronale Netze für Stereo. Frage:
Wird das Tracking damit so genau, dass die Kameras näher beieinander und nicht im rechten Winkel stehen
können?

## Antwort in Kürze

- **Beliebige Winkel gehen schon.** Die Tracking-Seite kalibriert die Kameras aus den Gelenken der
  Person (`core/stereo.ts`) und trianguliert für jede Anordnung; der EKF korrigiert mit jedem Bildpunkt
  einzeln (`core/ekf.ts`). Ein rechter Winkel war nie nötig.
- **Rektifizierung macht nicht genauer.** Sie dreht jede Kamera nur um ihr eigenes Zentrum
  (Homographie `H = K' R K⁻¹`), es kommt keine Information dazu. Sie ist für dichtes Stereo gedacht
  (Tiefe für jeden Bildpunkt), nicht für einzelne Gelenke.
- **Die Physik bleibt.** Tiefenfehler für parallele Kameras:

  ```
  σZ = Z² / (f · b) · σd        Z Distanz, b Kameraabstand, f Brennweite, σd Fehler der Disparität
  ```

  Doppelte Distanz = vierfacher Fehler, doppelter Abstand = halber Fehler. Für gedrehte Kameras zählt
  der Winkel zwischen den Sehstrahlen am Punkt; je grösser, desto genauer.

  Beispiel: 2,5 m Distanz, 30 cm Abstand, Brennweite 900 px, 3 px Fehler der Gelenkerkennung pro Bild
  ergibt rund 10 cm Tiefenfehler. Für etwa 2 cm braucht es grob 1 m Abstand oder etwa 30° zwischen den
  Sehstrahlen.
- **Dichtes neuronales Stereo** (RAFT-Stereo, CREStereo, IGEV-Stereo, FoundationStereo) passt hier
  nicht: Es misst die Oberfläche der Kleidung, nicht die Gelenke im Körper; es braucht gleichzeitig
  aufgenommene Bilder (Webcam und Handy sind nicht synchronisiert); es läuft nicht in Echtzeit im
  Browser; und bei kleinem Abstand gilt dieselbe Formel. Der passende Weg für genauere Gelenke aus
  mehreren Kameras wäre lernende Triangulation (Iskakov et al. 2019), braucht aber Training und GPU.

## Was gebaut wurde

| Teil | Wo | Was |
|---|---|---|
| Rektifizierung | `core/rectify.ts` | Drehungen nach Fusiello (x entlang der Basislinie, z nahe der mittleren Blickrichtung), Tiefe aus Disparität, Genauigkeit der Triangulation per Fehlerfortpflanzung (gilt für beliebig gedrehte Kameras) |
| Rektifizierte Ansicht | `tracking/rectified-view.ts` | Beide Bilder live per WebGL-Shader rektifiziert, mit Epipolarlinien; gleiche Gelenke verbunden |
| Genauigkeitsanzeige | Tracking-Seite, «Rektifizierte Ansicht und Genauigkeit» | Zeilenversatz gleicher Gelenke (prüft die Kalibrierung), Tiefe und seitlich an der Hüfte in cm, Winkel der Sehstrahlen, Kameraabstand für ±2 cm |
| Glättung | `core/one-euro.ts`, Regler «Glättung» | One-Euro-Filter nach Kalman/EKF: in Ruhe stark, bei schneller Bewegung kaum |
| Genaueres Handy-Skelett | `tracking/detectors.ts` | Kamera B mit MediaPipe «heavy», dazu Fingererkennung; sieht die Webcam eine Hand nicht, kommen die Finger vom Handy (nur mit Stereo-Kalibrierung) |
| Paralleles Rechnen | `tracking/detection.ts`, `tracking/detect-worker.ts` | Kamera B in einem Hintergrund-Strang, Kamera A im Hauptstrang |

Zum Vergleichen in der Adresse der Tracking-Seite: `?detA=` / `?detB=` `inline | worker | cpu`,
`?poseA=` / `?poseB=` `lite | full | heavy`.

### Wie die Genauigkeit geschätzt wird

Im rektifizierten Bild müssten gleiche Gelenke auf derselben Zeile liegen. Der verbleibende
Zeilenversatz misst Fehler der Gelenkerkennung plus Kalibrierfehler. Median des Betrags /0,674 ergibt
die Streuung des Versatzes, /√2 die eines einzelnen Bildpunkts. Daraus rechnet
`triangulationPrecision` die Unsicherheit des triangulierten Punkts. Weil die Kameras nicht gleichzeitig
aufnehmen, wächst der Versatz bei Bewegung; für eine faire Messung kurz still stehen.

## Messungen: Wo die Erkennung rechnen soll

Testvideo mit 30 Bildern/s (540p) als beide Kameras, Chrome ohne Fenster auf dem MacBook. Mehr als 30
ist nicht möglich.

| Aufteilung | Webcam (A) | Handy (B, heavy) |
|---|---|---|
| beide nacheinander im Hauptstrang (vorher) | 26–30 Bilder/s | ~25 ms pro Bild |
| beide in Hintergrund-Strängen, GPU | 16–20 Bilder/s | ~40 ms pro Bild |
| A Hauptstrang, B Hintergrund auf CPU | 30 | ~10 Bilder/s (100 ms) |
| **A Hauptstrang, B Hintergrund auf GPU (Standard)** | **30** | **27–30 Bilder/s, ~20 ms** |

Erkenntnis: Der Engpass ist die GPU, nicht der Rechenstrang. Zwei Hintergrund-Stränge haben je einen
eigenen GPU-Kontext und streiten sich, dazu kommt die Kopie jedes Bildes (`ImageBitmap`). Im
Hauptstrang liest MediaPipe das Videobild ohne Kopie. MediaPipe braucht einen klassischen Worker (kein
Modul), weil es seinen WebAssembly-Teil mit `importScripts` lädt. Mit echten Kameras noch nicht gemessen.

## Beobachtungen im Live-Test

- **Kalibrierfehler 13,5 px** bei der ersten Stereo-Kalibrierung (Abstand 1,66 m, Kameras 67° gedreht).
  Ursache vermutlich Kamera A: nicht mit dem Schachbrett kalibriert, Öffnungswinkel nur geschätzt.
  Falsche Brennweite = Sehstrahlen passen nicht zusammen = Gelenke springen, egal mit welchem Filter.
  Zuerst Kamera A mit dem Schachbrett kalibrieren, dann Stereo neu; Ziel unter etwa 5 px.
- **17 Bilder/s** im Live-Test vor dem Umbau (beide Kameras, Finger, Splat), Grund für einen Teil des
  Wackelns.
- **iPhone erschien nicht in Chrome.** macOS sah die Continuity-Kamera, Chrome nicht (Chrome liest die
  Kameraliste oft nur beim Start). Über die Splattwin-App ging es.
- **Brücke der Mac-App öffnete sich nicht, ohne Fehler.** Port 8932 war von einem alten
  `splattwin serve 8932` belegt. Nach dessen Ende und einem Neustart der App ging es. Ursache im Code:
  `WebBridge.start()` (`app/Kit/Sources/SplattwinKit/WebBridge.swift`) setzt keinen
  `stateUpdateHandler`; scheitert der Listener erst nach dem Start, merkt die App es nicht. Also:
  Port 8932 nie für den Server verwenden.
- **Die Mac-App rechnet mit.** Sie erkennt auf jedem verbundenen Handy selbst Körper und Gesicht (bis
  20 Bilder/s, für die geführte Aufnahme), auch beim Live-Tracking. Das kostet GPU, die Chrome fehlt.

## Offen

- Alles oben mit zwei echten Kameras prüfen (Bildrate, Glättung, Genauigkeitsanzeige).
- Kamera A mit dem Schachbrett kalibrieren, Stereo neu.
- Mac-App: Fehler der Brücke anzeigen und neu versuchen; eigene Körper- und Gesichtserkennung
  pausieren, solange keine Aufnahme läuft.
- Finger aus beiden Kameras echt fusionieren (heute nur Ersatz, wenn Kamera A eine Hand nicht sieht).
