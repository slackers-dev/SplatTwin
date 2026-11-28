# 0011: Höhe der Hüfte aus dem Kamerabild, Beine per IK

- **Status:** angenommen
- **Datum:** 28.11.2026
- **Beteiligt:** Beni, Claude

## Ausgangslage

Der Avatar soll mitgehen, wenn die Person in die Knie geht oder springt. Bisher hing die Höhe nur an den
Beinpunkten von MediaPipe: Der tiefste Fuss blieb auf dem Boden. Mit dem eigenen Video (Hocke bei 39 s)
gemessen:

- Die Hüfte sinkt im Bild um rund 35 cm, die Weltpunkte von MediaPipe zeigen aber nur etwa 20 cm
  Beinbeugung. Die Knöchel sind oft unter der Sichtbarkeitsschwelle, dann sind die Beine gestreckt.
- Am Laptop sieht die Kamera die Beine gar nicht. Der Avatar sank dann überhaupt nicht.

## Entscheidung

Die Höhe der Hüfte kommt aus dem Lochkamera-Modell (`core/measure.ts`, `estimateRoot`): Tiefe aus
Rumpfstrecken (ohne Hüfte im Bild aus Schultern und Ohren), jeder sichere Ankerpunkt (Schultern, Hüfte)
auf seinem Sehstrahl minus seine Lage relativ zur Hüfte. So bleibt die Höhe beim Vorbeugen gleich.
`core/height.ts` macht daraus die Höhe relativ zum Stehen beim Start. Der Avatar steht auf dieser Höhe,
die Beine knicken mit Zwei-Knochen-IK so ein, dass die Füsse auf dem Boden bleiben
(`Retargeter.standAt`). Getrackte Beine geben nur die Richtung von Knie und Fuss vor.

## Betrachtete Alternativen

- **Nur die Beinpunkte (bisher):** zu wenig Beugung, ohne sichtbare Beine gar nichts.
- **Vertikale Bildposition ohne Tiefe:** hängt von der Entfernung ab, beim Vorbeugen sinkt die Figur.

## Folgen

- Gemessen mit dem eigenen Video: Hocke 33 bis 37 cm tief, sonst ±2 cm; nur Oberkörper im Bild
  (Laptop) 27 bis 41 cm, beim Drehen bis 10 cm Rauschen.
- Die Höhe gilt relativ zur Bildmitte. Eine stark geneigte Kamera verfälscht sie, wenn die Person nach
  vorne oder hinten läuft (bei der eigenen Aufnahme unter 8 cm auf 1 m).
- Das Live-Format hat dafür ein Feld `height` (Version 2, Kopf 16 Bytes).

## Quellen

`web/src/core/height.ts`, `web/src/avatar/retarget.ts`, `web/src/avatar/retarget-height.test.ts`
