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
`lhm_zum_viewer.py` den Avatar nach `data/runs/lhm-<name>/`, stellt ihn auf den Boden und bestimmt die
Gelenke (`rig.json`, aus einem Render von vorne mit MediaPipe, Kontrolle in `rig_render.jpg`). Ansehen mit
`viewer.html?run=lhm-<name>`, bewegen mit `tracking.html?run=lhm-<name>`.

Fotos aus einer Drehaufnahme: etwa jedes 15. Bild aus `data/runs/<lauf>/frames/` nehmen, 8 Stück reichen.

**Das Einrichten** (LHM++ installieren, CUDA-Erweiterungen bauen, 13 GB Modelle laden, Probelauf) dauert
etwa 25 Minuten und läuft nur einmal, oder wenn sich `setup-lhm.sh` oder `image` ändert. Danach liegt die
Umgebung als Archiv (14 GB) auf dem Volume, und ein neuer Pod holt sie in etwa 2 Minuten.

**API-Schlüssel:** pod-do liest ihn auch aus `POD_API_KEY` in der `.env` im Projekt (steht in `.gitignore`).

**Gute Fotos** (laut LHM++): 4 bis 8 Stück rundherum (vorne, Seiten, hinten, schräg), hoch aufgelöst,
gleiches Licht, ganze Person im Bild, Hände gut sichtbar, mindestens eines mit ausgebreiteten Armen
(A-Pose wie in [`docs/drehbuch-brush.md`](../../docs/drehbuch-brush.md)).

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
