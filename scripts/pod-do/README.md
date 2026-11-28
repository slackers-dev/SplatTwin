# Rechnen auf RunPod mit pod-do

Was eine Nvidia-GPU braucht (zuerst LHM++, später ExAvatar), rechnet ein gemieteter Pod bei
[RunPod](https://www.runpod.io). Bedient wird er vom Mac aus mit
[pod-do](https://github.com/slackers-dev/pod-do). Ein Befehl startet den Pod, lädt die Eingaben hoch,
rechnet und holt das Ergebnis. Die Aufgaben stehen in [`pod-do.toml`](../../pod-do.toml).
Hintergrund in [Entscheidung 0008](../../project-documentation/entscheidungen/0008-gpu-runner-pod-do.md).

> **Getestet am 26.11.2026** auf einer L4 mit den Beispielbildern von LHM++: Ergebnis-PLY mit 160 000
> Gaussians. Von null (neuer Pod) bis zum Ergebnis gut 5 Minuten, davon etwa 1 Minute rechnen, rund 6 Rappen.

## Einmal einrichten

```sh
uv tool install git+https://github.com/slackers-dev/pod-do
pod-do login            # API-Schlüssel aus RunPod → Settings → API Keys, landet im Schlüsselbund
pod-do volume --create  # Global Volume, die ersten 100 GB sind gratis
pod-do check            # Konfiguration lesen, freie GPUs zeigen
```

## Avatar aus Fotos (LHM++)

```sh
make lhm FOTOS=~/Desktop/fotos-beniam            # Name = Ordnername
make lhm FOTOS=~/Desktop/fotos-beniam NAME=beniam
pod-do down                                      # Pod gleich weg, sonst nach 20 min Leerlauf
```

Ergebnis: `data/lhm/<name>/avatar.ply` (T-Pose, SMPL-X). Die aufbereiteten Fotos liegen daneben in
`data/lhm/<name>/fotos/`. Fotos als JPG, PNG oder HEIC, höchstens 16. Danach kopiert
`lhm_zum_viewer.py` den Avatar nach `data/runs/lhm-<name>/`, stellt ihn auf den Boden und schreibt das
SMPL-X-Skelett mit den Gewichten von LHM++ (`smplx.json`, `smplx_skin.bin`; auf dem Pod mitgeschrieben von
`lhm_export.py`). Ansehen mit `viewer.html?run=lhm-<name>`, bewegen mit `tracking.html?run=lhm-<name>`.
Für den alten Weg über das Roboter-Skelett entsteht zusätzlich `rig.json` (Gelenke aus einem Render von
vorne mit MediaPipe, Kontrolle in `rig_render.jpg`).

**SMPL-X-Lizenz:** Gewichte und Gelenke stammen aus dem SMPL-X-Modell (nur Forschung und Studium). Sie
liegen nur unter `data/`, nie im Repo.

Fotos aus einem Video: Standbilder einer langsamen Drehung in A-Haltung, z. B. 13 Stück für
`data/beispiel-fotos/beni-video` (`ffmpeg -ss <sekunde> -i video.mp4 -frames:v 1 -q:v 2 bild.jpg`).

Fotos aus einer Drehaufnahme: etwa jedes 15. Bild aus `data/runs/<lauf>/frames/` nehmen, 8 Stück reichen.

**Das Einrichten** (LHM++ installieren, CUDA-Erweiterungen bauen, 13 GB Modelle laden, Probelauf) dauert
etwa 25 Minuten und läuft nur einmal, oder wenn sich `setup-lhm.sh` oder `image` ändert. Danach liegt die
Umgebung als Archiv (14 GB) auf dem Volume, und ein neuer Pod holt sie in etwa 2 Minuten.

**API-Schlüssel:** pod-do liest ihn auch aus `POD_API_KEY` in der `.env` im Projekt (steht in `.gitignore`).

**Gute Fotos** (laut LHM++): 4 bis 8 Stück rundherum (vorne, Seiten, hinten, schräg), hoch aufgelöst,
gleiches Licht, ganze Person im Bild, Hände gut sichtbar, mindestens eines mit ausgebreiteten Armen
(A-Pose wie in [`docs/drehbuch-brush.md`](../../docs/drehbuch-brush.md)).

## Avatar aus einem Video (ExAvatar)

ExAvatar trainiert aus einem Video einen Avatar mit Körper, Händen und Mimik auf SMPL-X. Aufnahme nach
[`docs/drehbuch-exavatar.md`](../../docs/drehbuch-exavatar.md), Kamera fest.

```sh
pod-do run exavatar beni     # Daten aus data/exavatar/beni/, Ergebnis in data/exavatar/beni/avatar/
```

Vorbereiten (einmal pro Video):

1. Video als SDR-MP4 nach `data/exavatar/<name>/video.mp4`. iPhone-Videos sind HDR (Dolby Vision) und
   liegen gedreht im Container: `avconvert --source IMG.MOV --preset Preset1920x1080 --output v.mov`,
   dann `ffmpeg -i v.mov -c copy -an video.mp4`.
2. `frame_list_all.txt`, `frame_list_train.txt`, `frame_list_test.txt` daneben, eine Bildnummer pro
   Zeile (ab 0). Nur Bilder, auf denen die ganze Person zu sehen ist. Bewährt: alle mit 10 Bildern pro
   Sekunde (`seq 120 3 1680`), Training mit 5 (`seq 120 6 1680`), Test eine Auswahl daraus.
   **Achtung:** Das Fitting löscht alle Bilder, die nicht in `frame_list_all.txt` stehen.
3. Die Körpermodelle (SMPL-X, FLAME, SMPL) brauchen eigene Konten bei den MPI-Seiten. Die ZIPs
   unverändert nach `data/models/mpi/` (Liste in `data/models/mpi/LIESMICH.md`). Sie gehen bei jedem Lauf
   mit hoch und kommen nie in die Umgebung oder ins Repo; `exavatar_modelle.sh` legt sie auf dem Pod ab.

Ablauf auf dem Pod: Bilder aus dem Video, SMPL-X anpassen (DECA, Hand4Whole, DWPose, Fit), Masken (SAM),
Hintergrund (Depth-Anything), Training (5 Epochen), Ansichten in Ruhehaltung. `exavatar_export.py` wertet
die Netze von ExAvatar einmal in der Ruhehaltung aus und schreibt `avatar.ply` und `skin.npz` im selben
Format wie LHM++. `lhm_zum_viewer.py <name> exavatar` legt daraus `data/runs/exavatar-<name>/` an.

Laut den Issues von ExAvatar dauert das 2 bis 3 Stunden auf einer 24-GB-Karte und braucht 17 bis 20 GB
Speicher (nicht selbst gemessen). Die Umgebung (torch 2.1.2, mmcv 2.1, pytorch3d 0.7.5, 7.6 GB Archiv)
ist eingerichtet und mit einem Probelauf geprüft. Das Fitting, das Training und der Export sind noch
nicht getestet, weil die Körpermodelle fehlen.

## Als Docker-Image (optional)

`pod-do.toml` nennt für LHM++ ein privates Image `ghcr.io/slackers-dev/splattwin-lhm:<setup-hash>`. Ist der
Zugang eingerichtet, baut pod-do es einmal auf dem Pod und startet danach jeden Pod direkt daraus. Ohne
Zugang läuft alles wie bisher über das Archiv auf dem Volume. Einrichten (einmal pro Rechner, Details im
README von pod-do):

```sh
pod-do registry login ghcr.io --user <github-name>   # Token mit write:packages und read:packages
pod-do registry runpod                               # dieselben Zugangsdaten bei RunPod (oder in der Konsole)
pod-do image lhm                                     # bauen und hochladen, etwa 10 bis 15 Minuten
```

Das Image enthält Modelle mit Forschungslizenz (SMPL-X): **privat lassen**.

## Nützlich

```sh
pod-do status     # Guthaben, laufende Pods
pod-do ssh        # Shell auf dem Pod, z. B. bei Fehlern: cat /opt/pod-do/jobs/_bootstrap/log
pod-do attach     # nach Ctrl-C oder Verbindungsabbruch wieder an den Job hängen
pod-do gpus --min-vram 8
```

## Wenn etwas schiefgeht

- **`nvcc fehlt` oder Fehler beim Bauen von `pointops`, `diff-gaussian-rasterization`:** Image ohne
  CUDA-devel oder mit anderer CUDA-Version. `image` in `pod-do.toml` prüfen.
- **Neu einrichten:** Jede Änderung an `setup-lhm.sh` oder `image` richtet beim nächsten Lauf neu ein.
- **`CUDA out of memory` schon bei wenigen Fotos:** flash-attn fehlt. Ohne braucht der Sonata-Encoder mehr
  als 24 GB statt etwa 8 GB.
- **Modell-Download scheitert (401 bei Hugging Face, 403 bei ModelScope):** Das Modell liegt nur auf ModelScope,
  das bei vielen Anfragen drosselt. Später nochmals versuchen.
- **Keine GPU frei:** `pod-do gpus` zeigt, was es gibt, `make lhm ... ` mit
  `pod-do run lhm <fotos> --gpu "NVIDIA A40"` ersetzen.

## Lizenz

LHM++ steht unter Apache-2.0. Die mitgeladenen SMPL-X-Modelldateien sind nur für Forschung und Studium
freigegeben, dafür braucht es ein eigenes Konto auf https://smpl-x.is.tue.mpg.de.
