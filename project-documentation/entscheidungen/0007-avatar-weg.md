# 0007: Avatar-Weg: SMPL-X mit ExAvatar

- **Status:** offen
- **Datum:** 20.11.2026 (vorgeschlagen)
- **Beteiligt:** Team

## Ausgangslage

Heute trainiert Brush einen starren Splat. Danach hängt `web/src/avatar/splat-avatar.ts` ihn an das
Skelett des Roboters (Gewichte vom Roboter übernommen) und Spark verformt ihn pro Bild. Bewegt sich die
Person bei der Aufnahme, wird der Splat unscharf. Hände und Gesicht bleiben starr.

## Vorschlag

Gaussians beim Training an ein Körpermodell (SMPL-X) hängen und die Posen mittrainieren. Kandidat ist
**ExAvatar** (ECCV 2024, Meta, MIT-Lizenz): ein Video einer Person, SMPL-X mit Körper, Händen und
Gesicht. Training auf einer gemieteten GPU (RunPod, 24 GB oder mehr).

## Betrachtete Alternativen

- **Beim heutigen Weg bleiben:** läuft auf dem Mac, aber nur mit starren Aufnahmen scharf, keine Mimik.
- **3DGS-Avatar** (CVPR 2024): einfacher, nur Körper (SMPL), Posen von einem anderen Werkzeug.
- **LHM** (ICCV 2025, Code offen, Apache-2.0): genau ein Foto, Ergebnis in Sekunden. Rückseite und
  Details nur geschätzt. Stand README, 26.11.2026, nicht ausprobiert:
  - «bewegbar» nur in der eigenen Pipeline: `inference.sh` rendert aus Foto und SMPL-X-Posen ein Video
  - `inference_mesh.sh` exportiert den Avatar nur in einer Grundpose, ohne Skelett und Gewichte
  - braucht Linux mit CUDA und eine GPU mit 14 bis 24 GB; läuft nicht auf dem Mac
  - gegenüber LHM++ für uns schlechter: nur ein Foto, grössere GPU, gleicher Aufwand beim Skinning
- **LHM++** (2025, Nachfolger von LHM, Code seit März 2026 offen, Apache-2.0): ein oder mehrere Fotos
  ohne Kamerapositionen, bewegbarer Avatar an SMPL-X in etwa 1 s (8 Fotos: 1,3 s). Kein Training pro
  Person. Gut als schneller erster Test auf dem Pod (Stand README, 26.11.2026, nicht ausprobiert):
  - braucht Linux mit CUDA 12.1 und Python 3.10, GPU ab 8 GB; läuft nicht auf dem Mac
  - `scripts/inference/to_gs_ply.py` exportiert eine normale 3DGS-`.ply` (nur Varianten
    `LHMPP-700M-PixelShuffle` und `LHMPP-700M-SMPLX-FREE`), wahlweise in T-Pose oder in einer Pose
  - die `.ply` ist starr: Für das Live-Tracking die T-Pose exportieren und die Gaussians selbst an ein
    SMPL-X-Skelett hängen (Skinning in Spark bauen)
  - die Demo-Bilder laufen durch einen neuronalen Nachbearbeiter, den Spark nicht hat; massgebend ist
    die Qualität im Modus `gs_render` (nur Splats)
  - Fotos hochaufgelöst, Hände sichtbar, mindestens ein Bild mit ausgebreiteten Armen (A-Pose wie im
    Drehbuch)
  - lädt die SMPL-X-Modelldateien automatisch mit; deren Lizenz gilt trotzdem. Kein Training-Code.
- **HumanGS** (2026): wenige Kamerabilder mit SMPL-X-Posen, passt zum Aufbau mit mehreren Handys.

Bei allen drei Wegen (ExAvatar, LHM, LHM++) gibt es kein fertig geriggtes Modell für den Browser. Die
Gaussians liegen in der Grundpose von SMPL-X. Selbst zu bauen sind deshalb immer: jedem Gaussian die
Gewichte des nächsten SMPL-X-Punkts geben und in Spark pro Bild verformen, und das Live-Tracking so
umbauen, dass es SMPL-X-Posen liefert. Ohne eigene GPU lassen sich LHM und LHM++ vorab in ihren
Online-Demos auf Hugging Face ausprobieren (Fotos gehen dabei an einen fremden Dienst).

## Was wir ausprobieren wollen

Das heutige Mapping auf das Roboter-Skelett ist nur mässig gut und bräuchte noch viel Arbeit. Wir sind
bereit, davon wegzugehen, wenn ein anderer Weg sichtbar besser aussieht. Die Idee: Der Avatar entsteht
direkt auf SMPL-X, statt nachträglich auf ein fremdes Skelett gelegt zu werden. Die Gewichte für die
Bewegung bringt SMPL-X mit, das Zerlegen in Körperteile und das Überblenden an den Gelenken fallen weg.

Das wollen wir Schritt für Schritt testen, jeder Schritt zeigt, ob sich der nächste lohnt:

1. **Anschauen:** das LHM-Beispiel in Visionary laden und sehen, wie ein solcher Avatar in Bewegung
   aussieht (ohne eigene GPU).
2. **Eigener Avatar:** LHM++ mit eigenen Fotos auf einem Pod laufen lassen und die T-Pose als `.ply`
   exportieren (`to_gs_ply.py`). Die Online-Demo auf Hugging Face liefert nur ein Video, keine `.ply`.
3. **Skinning in Spark:** jedem Gaussian die Gewichte des nächsten SMPL-X-Punkts geben, das SMPL-X-Skelett
   als three.js-Skelett aufbauen und mit `SplatSkinning` verformen, wie heute beim Roboter.
4. **Live-Bewegung:** den Retargeter von den Knochen des Roboters auf das SMPL-X-Skelett umstellen,
   zuerst mit MediaPipe. Reicht das nicht, ein Modell suchen, das SMPL-X-Posen direkt aus dem Bild
   schätzt (auf dem Server).
5. **Mehr Qualität:** ExAvatar statt LHM++ trainieren. Gleiches Format, die Schritte 3 und 4 bleiben.

Ab Schritt 3 ist alles SMPL-X: LHM++ und ExAvatar lassen sich austauschen, ohne den Browser-Teil
anzufassen. Bleibt die Qualität in Spark hinter Visionary zurück, ist auch ein Wechsel des Renderers
möglich.

Vorlagen, die wir anschauen wollen (nicht ausprobiert):

- **Visionary** (Apache-2.0): Viewer auf WebGPU mit three.js-Anbindung, bewegt LHM-Avatare mit SMPL-X-Posen
  pro Bild über ONNX. Eigener Renderer statt Spark, Bewegung in den Beispielen aus Dateien (AMASS).
  https://github.com/Visionary-Laboratory/visionary
- **Gaussian-VRM** (MIT): hängt Splats in three.js an ein VRM-Skelett, Avatar aus einem Handy-Scan.
  Vorlage für sauberes Skinning und die Drehung der Gaussians an Gelenken.
  https://github.com/naruya/gaussian-vrm
- **LAM** (vom LHM-Team): Web-Renderer mit GPU-Skinning, aber nur für Köpfe (FLAME). Höchstens später
  für Mimik interessant. https://github.com/aigc3d/LAM

Risiken: Die Qualität der reinen Splats von LHM++ (ohne neuronalen Nachbearbeiter) ist ungetestet. Die
GPU läuft auf einem Pod, nicht auf dem Mac. Live von MediaPipe zu SMPL-X-Posen im Browser gibt es nichts
Fertiges.

## Folgen, falls angenommen

- `rig.py`, `merge_head.py`, das Roboter-Skinning in `splat-avatar.ts` und `skin-cache.ts` in der
  heutigen Form fallen weitgehend weg.
- Das Live-Tracking muss SMPL-X-Posen liefern statt nur MediaPipe-Punkte.
- Export nach Spark muss gebaut werden.
- SMPL-X und FLAME nur für Forschung und Studium, mit eigenem Konto.
- Aufnahmen nach [`docs/drehbuch-exavatar.md`](../../docs/drehbuch-exavatar.md).

## Was für den Entscheid noch fehlt

- [ ] Schritte 1 bis 3 aus «Was wir ausprobieren wollen»: sieht der SMPL-X-Weg besser aus als heute?
- [ ] Machbarkeitstest mit dem Beispielvideo von ExAvatar auf dem Pod
- [ ] Eigene Aufnahme nach dem Drehbuch, Vergleich mit Brush
- [ ] Entscheiden, ob zuerst LHM++ getestet wird: Fotos rundherum, `.ply` in Spark laden, Qualität
  von `gs_render` mit Brush vergleichen

## Quellen

- [`docs/notizen-smpl-avatar.md`](../../docs/notizen-smpl-avatar.md)
- ExAvatar: https://mks0601.github.io/ExAvatar, https://arxiv.org/abs/2407.21686
- LHM: https://github.com/aigc3d/LHM, https://arxiv.org/abs/2503.10625
- LHM++: https://github.com/aigc3d/LHM-plusplus, https://arxiv.org/abs/2506.13766
- HumanGS: https://arxiv.org/abs/2604.10259
