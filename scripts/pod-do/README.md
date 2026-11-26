# Rechnen auf RunPod mit pod-do

Was eine Nvidia-GPU braucht (zuerst LHM++, später ExAvatar), rechnet ein gemieteter Pod bei
[RunPod](https://www.runpod.io). Bedient wird er vom Mac aus mit
[pod-do](https://github.com/slackers-dev/pod-do). Ein Befehl startet den Pod, lädt die Eingaben hoch,
rechnet und holt das Ergebnis. Die Aufgaben stehen in [`pod-do.toml`](../../pod-do.toml).
Hintergrund in [Entscheidung 0008](../../project-documentation/entscheidungen/0008-gpu-runner-pod-do.md).

> **Noch nicht getestet** (Stand 26.11.2026): pod-do ist gegen einen lokalen Container getestet, LHM++ auf
> einem echten Pod noch nicht. Beim ersten Lauf kann es nötig sein, Versionen in `setup-lhm.sh` nachzubessern.

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
`data/lhm/<name>/fotos/`. Fotos als JPG, PNG oder HEIC, höchstens 16.

**Der erste Lauf dauert 20 bis 40 Minuten**: LHM++ installieren, CUDA-Erweiterungen bauen, Modelle laden,
Probelauf. Danach liegt alles als Archiv auf dem Volume, und jeder neue Pod ist in wenigen Minuten bereit.

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
- **Keine GPU frei:** `pod-do gpus` zeigt, was es gibt, `make lhm ... ` mit
  `pod-do run lhm <fotos> --gpu "NVIDIA A40"` ersetzen.

## Lizenz

LHM++ steht unter Apache-2.0. Die mitgeladenen SMPL-X-Modelldateien sind nur für Forschung und Studium
freigegeben, dafür braucht es ein eigenes Konto auf https://smpl-x.is.tue.mpg.de.
