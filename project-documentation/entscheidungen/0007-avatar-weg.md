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
- **LHM** (ICCV 2025): ein Foto genügt, Ergebnis in Sekunden. Gut als schneller erster Test auf dem Pod.
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
- [x] Entscheiden, ob zuerst LHM getestet wird: ja, am 26.11.2026. LHM++ läuft über pod-do
  (Entscheidung 0008), der Avatar wird im Browser über sein SMPL-X-Skelett bewegt
  (`web/src/avatar/smplx-avatar.ts`). Deutlich besser als über das Roboter-Skelett. Live-Tracking liefert
  dafür weiter nur MediaPipe-Punkte, daraus werden die Gelenke gedreht. Hände und Gesicht noch starr.

## Quellen

- [`docs/notizen-smpl-avatar.md`](../../docs/notizen-smpl-avatar.md)
- ExAvatar: https://mks0601.github.io/ExAvatar, https://arxiv.org/abs/2407.21686
- LHM: https://arxiv.org/abs/2503.10625
- HumanGS: https://arxiv.org/abs/2604.10259
