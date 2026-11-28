# 0009: Avatar offline mit generativer KI verfeinern

- **Status:** offen
- **Datum:** 26.11.2026 (vorgeschlagen)
- **Beteiligt:** Benjamin, mit Claude

## Ausgangslage

Der Avatar von LHM++ bewegt sich über sein SMPL-X-Skelett (Entscheidung 0007, 0008). Texturen sind etwas
weich, Gesicht und Hände schwach. Frage: Kann generative KI das verbessern? Recherche:
[`docs/notizen-genai-verfeinerung.md`](../../docs/notizen-genai-verfeinerung.md).

## Vorschlag

Zuerst eine bessere Aufnahme (16 scharfe Fotos, Nahaufnahmen von Gesicht und Händen). Danach als Experiment
ein pod-do-Rezept, das den Avatar offline verfeinert: rendern, mit Difix (und für das Gesicht GFPGAN)
aufbessern, nur Farben und Opazität der Gaussians neu einpassen. Positionen und Reihenfolge bleiben, damit
die SMPL-X-Gewichte gültig bleiben. Das Ergebnis bleibt ein normaler Splat für Spark und die Bühne.

## Betrachtete Alternativen

- **Live-Nachbearbeitung** (StreamDiffusion, Neural Refiner von LHM++): fotorealistischer, aber eine GPU pro
  Zuschauer, Flackern, passt nicht zur Bühne, auf der nur Gelenke übertragen werden.
- **Nur bessere Aufnahme**: billigster Gewinn, gehört ohnehin zuerst. Das Gesicht bleibt in der
  Ganzkörperaufnahme trotzdem klein.
- **ExAvatar** (aus einem Video trainiert): Hände und Mimik eingebaut, aber eigenes Format und mehr Arbeit
  für den Export nach Spark. Bleibt in Entscheidung 0007 offen.

## Folgen, falls angenommen

- Neues pod-do-Rezept (`env` mit gsplat und Difix, `task` zum Verfeinern), ein bis zwei Tage Arbeit.
- Pro Avatar etwa 20 bis 45 Minuten GPU (geschätzt).
- Difix und CodeFormer nur unter Forschungslizenz: in Ordnung fürs Studium, nicht für eine Veröffentlichung.

## Was für den Entscheid noch fehlt

- [ ] Neue Aufnahme nach den Hinweisen oben, mit LHM++ gerechnet (Vergleichsbasis)
- [ ] Prüfen, ob LHM++ Kameras und SMPL-X-Parameter pro Eingabefoto liefert
- [ ] Kleiner Versuch: 36 Ansichten rendern, mit Difix bearbeiten, ansehen, ob die Identität bleibt

## Quellen

Siehe [`docs/notizen-genai-verfeinerung.md`](../../docs/notizen-genai-verfeinerung.md).
