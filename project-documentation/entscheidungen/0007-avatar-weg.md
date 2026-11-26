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
- **LHM** (ICCV 2025): ein Foto genügt, Ergebnis in Sekunden. Rückseite und Details nur geschätzt.
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

## Folgen, falls angenommen

- `rig.py`, `merge_head.py` und das Roboter-Skinning fallen weitgehend weg.
- Das Live-Tracking muss SMPL-X-Posen liefern statt nur MediaPipe-Punkte.
- Export nach Spark muss gebaut werden.
- SMPL-X und FLAME nur für Forschung und Studium, mit eigenem Konto.
- Aufnahmen nach [`docs/drehbuch-exavatar.md`](../../docs/drehbuch-exavatar.md).

## Was für den Entscheid noch fehlt

- [ ] Machbarkeitstest mit dem Beispielvideo von ExAvatar auf dem Pod
- [ ] Eigene Aufnahme nach dem Drehbuch, Vergleich mit Brush
- [ ] Entscheiden, ob zuerst LHM++ getestet wird: Fotos rundherum, `.ply` in Spark laden, Qualität
  von `gs_render` mit Brush vergleichen

## Quellen

- [`docs/notizen-smpl-avatar.md`](../../docs/notizen-smpl-avatar.md)
- ExAvatar: https://mks0601.github.io/ExAvatar, https://arxiv.org/abs/2407.21686
- LHM: https://arxiv.org/abs/2503.10625
- LHM++: https://github.com/aigc3d/LHM-plusplus, https://arxiv.org/abs/2506.13766
- HumanGS: https://arxiv.org/abs/2604.10259
