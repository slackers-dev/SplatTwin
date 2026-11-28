# Notizen: Avatar mit generativer KI verfeinern

Stand 26.11.2026. Frage: Kann generative KI den Avatar von LHM++ schärfer und fotorealistischer machen
(Texturen, Stoffstruktur, Gesicht, Hände)? Recherche mit Quellen unten. Entscheidung dazu:
[0009](../project-documentation/entscheidungen/0009-genai-verfeinerung.md) (offen).

## Ausgangslage

- LHM++ macht aus 4 bis 16 Fotos einen Avatar mit etwa 160 000 Gaussians auf SMPL-X, in einer kanonischen
  Haltung, mit SMPL-X-Gewichten pro Gaussian (siehe [`scripts/pod-do/README.md`](../scripts/pod-do/README.md)).
- Der Avatar bewegt sich live im Browser (Spark, `web/src/avatar/smplx-avatar.ts`). Auf der Bühne gehen nur
  Gelenke übers Netz, jeder Zuschauer rendert selbst.
- Heute: Texturen etwas weich, Gesicht und Hände schwach. Die Eingabe waren 8 Bilder aus einem alten
  1080p-Drehvideo.

## Kurzfazit

Ja, aber sinnvoll ist nur der Weg «offline verfeinern, dann neu einpassen»: den Avatar aus vielen Richtungen
rendern, die Bilder mit einem 2D-Diffusionsmodell aufbessern und die Gaussians auf diese Bilder
nachoptimieren. Das Ergebnis bleibt ein normaler Splat und läuft weiter in Spark und auf der Bühne.
Generative Nachbearbeitung im Live-Betrieb passt nicht zur Bühne: Jeder Zuschauer bräuchte eine GPU oder
einen Videostream, dazu kommt Flackern. Der grösste und billigste Gewinn ist eine bessere Aufnahme.

Dass Hände und Gesicht sich nicht bewegen, ist kein Thema für generative KI. Dafür fehlt das Retargeting
(Fingerpunkte und Mimik von MediaPipe auf das SMPL-X-Skelett).

## Optionen

| Ansatz | Was es bringt | Aufwand, GPU | Risiken | Code, Lizenz |
|---|---|---|---|---|
| **Bessere Aufnahme**: 16 scharfe Fotos, 2 bis 3 Nahaufnahmen von Gesicht und Händen | echte statt erfundene Details | nur LHM++, Minuten | gering | LHM++ Apache-2.0 |
| **Difix3D**: Ansichten rendern, mit Difix bereinigen, Gaussians nachtrainieren | weniger Artefakte, schärfere Ansichten, Variante mit Referenzbild | eine 24-GB-GPU sollte reichen (Annahme) | für Szenen trainiert, nicht für Menschen; kann Identität oder Stoffmuster ändern | NVIDIA, Checkpoint nur Forschung |
| **3DGS-Superauflösung** (SR-GS, GaussianSR, 3DSR, SplatSuRe) | schärfere Texturen mit Massnahmen für Konsistenz | Training im Minutenbereich (Annahme) | erfundene Details sind zwischen Ansichten inkonsistent | Code geprüft nur bei SR-GS |
| **Gesicht pro Ansicht restaurieren** (GFPGAN, CodeFormer), dann neu einpassen | deutlich besseres Gesicht | gering | Gesicht wechselt zwischen Ansichten, Identität driftet; nur schwach einblenden | GFPGAN Apache-2.0, CodeFormer nicht-kommerziell |
| **Avatar-spezifische Verfeinerung** (EDGAR, SVAD) | genau dieses Muster: verfeinerte Renders als Ziel, Ergebnis bleibt ein Gaussian-Avatar | unbekannt | EDGAR nur Köpfe und sehr neu, Code nicht geprüft | Projektseiten |
| **Multi-View-Diffusion für Menschen** (PSHuman) | konsistente Ansichten aus einem Bild | mittel | Ausgabe ist ein Mesh, kein Splat | Lizenz nicht gefunden |
| **ExAvatar** (Training aus einem Video) | ganzer Körper mit Händen und Mimik über SMPL-X | Training pro Person | eigenes Format, Export nach Spark wäre Eigenarbeit | MIT |
| **Live-Nachbearbeitung** (StreamDiffusion, Neural Refiner von LHM++) | fotorealistischeres Bild | StreamDiffusion etwa 90 fps auf einer RTX 4090 (Angabe der Autoren), V2 auf 4×H100 | Flackern, eine GPU pro Zuschauer, Refiner nicht als PLY exportierbar | bricht das Bühnenkonzept |

Ein Feed-forward-Modell, das LHM++ bei Körper, Gesicht und Händen nachweislich schlägt, wurde nicht gefunden.

## Vorgeschlagenes Experiment

Auf einer GPU (L4 oder RTX 4090), als eigenes pod-do-Rezept:

1. **Neu aufnehmen**: 16 Fotos in 4K oder Standbilder aus einem 4K-Video, dazu Nahaufnahmen von Gesicht und
   Händen, Hände offen, gleichmässiges Licht. LHM++ wie heute (`make lhm`). Das ist der Vergleich.
2. **Rendern**: den kanonischen Avatar mit gsplat aus etwa 36 Richtungen, dazu etwa 12 Nahansichten von Kopf
   und Händen, 1024 px.
3. **Aufbessern**: jede Ansicht mit Difix (Referenzvariante, nächstes Originalfoto als Referenz). Gesichter
   zusätzlich mit GFPGAN, schwach eingeblendet.
4. **Neu einpassen**: in gsplat nur Farben, Opazität und eventuell Grössen optimieren. Positionen, Anzahl
   und Reihenfolge der Gaussians bleiben fest, sonst passen die SMPL-X-Gewichte (`smplx_skin.bin`) nicht
   mehr. Verlust L1 + SSIM + LPIPS, 2 bis 3 Runden mit erneutem Aufbessern (Prinzip aus Instruct-NeRF2NeRF).
5. **Vergleichen**: vorher und nachher in Bewegung im Browser, Blindvergleich im Team.

Schätzung, nicht gemessen: 20 bis 45 Minuten GPU pro Avatar, also unter einem Dollar. Einrichten ein bis
zwei Tage.

## Offene Fragen

- Liefert LHM++ zu jedem Eingabefoto SMPL-X-Parameter und Kamera? Dann könnten die Originalfotos im Fit als
  echte Ziele dienen.
- Erhält Difix bei Kleidung und Haut die Identität? Es ist auf Szenen trainiert.
- Hand- und Gesichtsbewegung: Die Gewichte für Finger- und Kiefergelenke stehen in `smplx_skin.bin`. Es
  fehlt das Retargeting der Fingerpunkte und Blendshapes.
- Lizenzen: Für das Studium reichen Forschungslizenzen. Für eine Veröffentlichung CodeFormer und Difix meiden.

## Geprüft und angenommen

Geprüft aus den Quellen: README von LHM++ (Renderer, Export, Speicher), Difix3D und Lizenzlage, Zahlen von
StreamDiffusion, Code und Lizenz von ExAvatar, Zusammenfassungen von EDGAR, SVAD, PSHuman und den
SR-Papers. Eigene Annahmen: GPU-Bedarf beim Nachtrainieren, Zeiten, Lizenzen von GFPGAN und CodeFormer.

## Quellen

- LHM++: https://github.com/aigc3d/LHM-plusplus, https://lingtengqiu.github.io/LHM++
- Difix3D: https://arxiv.org/abs/2503.01774, https://github.com/nv-tlabs/Difix3D,
  https://huggingface.co/nvidia/difix, Nachfolger https://huggingface.co/nvidia/Fixer
- SR-GS: https://arxiv.org/abs/2404.10318, https://github.com/XiangFeng66/SR-GS
- GaussianSR: https://arxiv.org/abs/2406.10111
- 3DSR: https://consistent3dsr.github.io/ (arXiv 2508.04090)
- SplatSuRe: https://arxiv.org/abs/2512.02172
- EDGAR: https://arxiv.org/abs/2611.07909
- SVAD: https://arxiv.org/abs/2505.05475
- PSHuman: https://arxiv.org/abs/2409.10141
- GAF: https://arxiv.org/abs/2412.10209, MoGA: https://arxiv.org/abs/2507.23597
- ExAvatar: https://mks0601.github.io/ExAvatar, https://github.com/mks0601/ExAvatar_RELEASE
- GUAVA: https://arxiv.org/abs/2505.03351, HumanGS: https://arxiv.org/abs/2604.10259
- StreamDiffusion: https://arxiv.org/abs/2312.12491, V2: https://streamdiffusionv2.github.io,
  https://arxiv.org/abs/2511.07399
