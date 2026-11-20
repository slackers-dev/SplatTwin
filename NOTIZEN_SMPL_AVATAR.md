# Notizen: unscharfe Splats und der SMPL-Weg

Stand 20.11.2026

## 1. Warum die neuen Splats schlechter sind als der erste

Vergleich des ersten Handy-Videos (IMG_0706) mit den App-Aufnahmen:

| | IMG_0706 (bester Splat) | scan-1101 | scan-1222 |
|---|---|---|---|
| Dauer der Drehung | **12 s** | 54 s | 77 s |
| Arme | ruhig | ruhig | bewegen sich sichtbar (App-Hinweis) |
| Person im Bild | gross | sehr klein | ok |
| Kleidung | farbig, gleichmässig beleuchtet | weiss | weiss, kaum Muster |
| Mittlere Track-Länge COLMAP | 7.6 | 6.9 | 5.7 |

Der Fehler steckt vor allem in der Aufnahme, nicht im Code. COLMAP und Brush gehen davon aus, dass
die Person starr ist. Je länger die Drehung dauert, desto mehr schwankt der Körper und wandern die
Arme. Der Splat mittelt diese Bewegungen und wird unscharf.

Regeln für eine starre Aufnahme:
- eine Umdrehung in 15 bis 20 s, am besten auf einem Drehstuhl oder einer Drehscheibe
- Arme in A-Pose fixiert, Fäuste geballt
- die Person füllt 70 bis 80 % der Bildhöhe, Kamera auf Brust- bis Hüfthöhe
- Kleidung mit Muster, weiches Licht

## 2. Was bereits geändert ist (Commit df7ddbc)

- App und capture.html: Richtzeit 20 s statt 30 s, Ansage «Schneller», Hinweis in der Aufnahme,
  wenn die Drehung mehr als das 1.5-fache dauert.
- splat_pipeline.py: Option `--focal` (Brennweite aus der App, relativ zur Bildbreite).
  **Nicht automatisch aktiv.** Auf scan-1222 wurde COLMAP damit schlechter:
  - Brennweite fest: nur 81 von 120 Frames registriert
  - Brennweite als Startwert: Kamerabahn nur 122 Grad statt 344 Grad
  - Vermutung: Die frei geschätzte Brennweite gleicht die wandernden Arme aus.
    An einer sauberen Aufnahme erneut testen.

## 3. Warum Tracking allein den Splat nicht scharf macht

Heute läuft das Tracking erst nach der Rekonstruktion und bewegt nur den fertigen Splat.
Damit das Tracking die Schärfe verbessert, muss es ins Training: Die Gaussians hängen an einem
Körpermodell (SMPL bzw. SMPL-X) und werden pro Frame mit der Pose verformt.

**Die Posen müssen dafür pixelgenau sein.** Die Person ist etwa 1.7 m gross und rund
1700 px hoch, also ist 1 px ungefähr 1 mm. MediaPipe liegt pro Gelenk 2 bis 5 cm daneben
(20 bis 50 px), und dann verschmiert der Arm trotzdem. Glättung entfernt nur das Zittern, nicht
bleibende Fehler wie einen falschen Ellbogen oder einen verdrehten Unterarm. Gute Verfahren passen
deshalb ein 3D-Körpermodell an und **korrigieren die Posen während des Trainings**.

## 4. Entscheid: SMPL-Weg mit RunPod-GPU

**Kandidat: ExAvatar** (ECCV 2024, Meta, MIT-Lizenz)
- animierbarer Gaussian-Avatar aus einem kurzen Video einer einzelnen Person
- SMPL-X: Körper, Hände, Gesicht
- eigener Fitting-Schritt (Gelenkpunkte, Hand- und Gesichtsmodelle, Pose-Optimierung)
- Laut Paper hängt die Qualität stark von der ersten SMPL-X-Anpassung ab
- Die 20 s «frei bewegen» nach der Drehung in der App sind genau passende Trainingsdaten

**Ausweichlösung: 3DGS-Avatar** (CVPR 2024): einfacher, nur Körper (SMPL), die Posen kommen von
einem anderen Werkzeug.

### Ablauf

1. Pod einrichten: CUDA-Umgebung, ExAvatar installieren, Modelldateien hochladen
2. Machbarkeitstest mit dem Beispielvideo von ExAvatar
3. Eigene Aufnahme (z. B. scan-1222): Frames und Masken liefert unsere Pipeline schon,
   danach SMPL-X anpassen und den Avatar trainieren
4. Avatar exportieren, im Browser anzeigen und mit dem Live-Tracking bewegen
   (das Live-Tracking muss dann SMPL-X-Posen liefern)

### Offene Aufgaben

- [ ] SMPL-X- und FLAME-Konto anlegen und die Modelle herunterladen (kostenlos, nur für
      Forschung und Studium, mit dem eigenen Konto)
- [ ] RunPod-Pod starten: GPU mit 24 GB oder mehr (RTX 4090, A6000, L40S), PyTorch/CUDA-Template,
      etwa 100 GB Speicher; SSH-Zugang (Host, Port, Schlüssel) an Claude weitergeben
- [ ] Bestätigen: Start mit ExAvatar, 3DGS-Avatar als Ausweichlösung
- [ ] Neue starre Aufnahme nach den Regeln oben (auch als Vergleich und Test für `--focal`)

Der Pod kostet pro Stunde, also nur laufen lassen, solange er gebraucht wird.

## Quellen

- ExAvatar Projektseite: https://mks0601.github.io/ExAvatar
- ExAvatar Paper: https://www.ecva.net/papers/eccv_2024/papers_ECCV/papers/05715.pdf
- ExAvatar Code: https://github.com/mks0601/ExAvatar_RELEASE
- 3DGS-Avatar Paper: https://openaccess.thecvf.com/content/CVPR2024/papers/Qian_3DGS-Avatar_Animatable_Avatars_via_Deformable_3D_Gaussian_Splatting_CVPR_2024_paper.pdf
