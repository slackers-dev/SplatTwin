# Drehbuch: Aufnahme für Brush (starrer Splat)

Ziel: Die Person bewegt sich nicht, nur die Ansicht ändert sich. Dauer etwa 30 s.
Hintergrund dazu: [`notizen-smpl-avatar.md`](notizen-smpl-avatar.md), Abschnitt 1.

## Vorbereitung

- [ ] Kamera fest auf Stativ, hochkant, 4K, auf Brust- bis Hüfthöhe
- [ ] Person füllt 70 bis 80 % der Bildhöhe, Füsse und Hände immer im Bild
- [ ] Drehstuhl oder Drehscheibe, Helfer zum Drehen
- [ ] Viel weiches Licht, Belichtung kurz (1/250 s oder schneller), dann «Einrichten und sperren»
- [ ] Enge Kleidung mit Muster, nichts Weisses, Haare zusammen
- [ ] Hintergrund ruhig, niemand sonst im Bild

## Ablauf

| Zeit | Person | Ansage |
|---|---|---|
| 0–4 s | ausserhalb des Bildes | «Bitte aus dem Bild gehen.» |
| 4–8 s | auf die Drehscheibe, A-Pose: Arme 30° vom Körper, Fäuste geballt, Blick geradeaus | «Hinstellen, Arme leicht zur Seite, Fäuste, nicht mehr bewegen.» |
| 8–26 s | **eine** gleichmässige Umdrehung (15 bis 20 s), Person bleibt völlig ruhig | «Drehung startet. Ruhig bleiben.» |
| 26–30 s | stehen bleiben, Blick zur Kamera | «Fertig, danke.» |

## Danach

```sh
uv run splattwin splat <video> --bg-start 0 --bg-seconds 4 --start 8 --end 26 --height <m>
uv run splattwin rig <name>
```

`--start` und `--end` auf die tatsächliche Drehung im Video anpassen.

## Häufige Fehler

- Drehung zu langsam (über 25 s): Der Körper schwankt, der Splat wird unscharf.
- Arme sinken während der Drehung: Die Arme verschmieren.
- Person zu klein im Bild: COLMAP findet zu wenige Punkte.
