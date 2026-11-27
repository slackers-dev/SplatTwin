# 0010: Rektifizierung als Messwerkzeug, kein dichtes Stereo im Tracking

- **Status:** angenommen
- **Datum:** 27.11.2026
- **Beteiligt:** Benjamin, Claude

## Ausgangslage

In der Vorlesung (3DRecon 2 und 3) kam die Rektifizierung dran: Zwei Kameras, die nicht parallel
stehen, werden rechnerisch so gedreht, als stünden sie parallel nebeneinander. Dann liegen gleiche
Punkte auf derselben Bildzeile, und die Tiefe folgt direkt aus der Disparität (Z = b / d). Neuronale
Netze für dichtes Stereo (RAFT-Stereo, CREStereo, IGEV-Stereo, FoundationStereo) liefern auf
rektifizierten Bildpaaren sehr gute Tiefenkarten.

Die Frage war, ob das unser Tracking mit Webcam und Handy genauer macht, sodass die Kameras näher
beieinander und nicht im rechten Winkel stehen können.

Stand heute: Die Tracking-Seite kalibriert die beiden Kameras aus den Gelenken der Person und
trianguliert die Gelenke; der EKF korrigiert mit jedem Bildpunkt einzeln. Beides rechnet schon mit
beliebig gedrehten Kameras (`web/src/core/stereo.ts`, `ekf.ts`).

## Entscheidung

Die Rektifizierung kommt als Mess- und Anschauungswerkzeug in die Tracking-Seite: rektifizierte
Ansicht beider Kameras mit Epipolarlinien, Zeilenversatz gleicher Gelenke und daraus eine Schätzung,
wie genau die Tiefe beim aktuellen Aufbau ist (`core/rectify.ts`, `tracking/rectified-view.ts`).
Die Triangulation selbst bleibt, wie sie ist. Dichtes neuronales Stereo bauen wir nicht ein.

## Betrachtete Alternativen

- **Triangulation über rektifizierte Bilder (Disparität statt Sehstrahlen):** Rektifizieren ist nur
  eine Drehung jeder Kamera um ihr Zentrum. Es kommt keine Information dazu, das Ergebnis für einzelne
  Gelenke ist dasselbe wie bei der heutigen Triangulation. Die Genauigkeit hängt nur vom Aufbau ab
  (Fehler ≈ Distanz² / (Brennweite · Abstand) · Bildpunktfehler) und vom Fehler der Gelenkerkennung.
- **Dichtes neuronales Stereo (z. B. FoundationStereo):** liefert die Oberfläche (Kleidung), nicht die
  Gelenke im Körper. Braucht gleichzeitig aufgenommene Bilder; Webcam und Handy sind nicht
  synchronisiert, bei Bewegung passen die Bilder nicht zusammen. Die Netze sind auf fast parallele
  Kameras mit kleinem Abstand trainiert und laufen nicht in Echtzeit im Browser. Bei kleinem Abstand
  gilt dieselbe Physik: Ein besserer Abgleich drückt den Bildpunktfehler, aber der Fehler wächst
  weiter mit dem Quadrat der Distanz.
- **Lernende Triangulation für Körperposen (z. B. Iskakov et al. 2019):** wäre der passende Weg für
  genauere Gelenke aus mehreren Kameras, braucht aber Training auf Mehrkamera-Datensätzen und eine GPU.
  Für das Homework zu gross.

## Folgen

- Man sieht jetzt am eigenen Aufbau, wie genau die Tiefe ist und welcher Kameraabstand für ±2 cm
  nötig wäre, statt zu raten.
- Der Zeilenversatz prüft die Kalibrierung: Bleibt er bei ruhiger Person über etwa 5 px, neu kalibrieren.
- Webcam und Handy nehmen nicht gleichzeitig auf; bei Bewegung wird der Versatz grösser und die
  Schätzung vorsichtiger. Für eine faire Messung kurz still stehen.
- Noch nicht mit zwei echten Kameras getestet, nur mit Testvideos und synthetischen Daten.

## Quellen

- Vorlesung CVAI, 3DRecon 2 und 3 (Epipolargeometrie, Rektifizierung, Disparität)
- A. Fusiello, E. Trucco, A. Verri: A compact algorithm for rectification of stereo pairs, 2000
- L. Lipson, Z. Teed, J. Deng: RAFT-Stereo, 2021; B. Wen et al.: FoundationStereo, 2025
- K. Iskakov et al.: Learnable Triangulation of Human Pose, 2019
