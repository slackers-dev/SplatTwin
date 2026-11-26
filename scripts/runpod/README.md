# LHM++ auf RunPod

Erzeugt aus Fotos einer Person einen Avatar als Gaussian Splat (`.ply` in T-Pose, auf SMPL-X), mit
[LHM++](https://github.com/aigc3d/LHM-plusplus). LHM++ braucht eine Nvidia-GPU und läuft darum auf
einem gemieteten Pod bei [RunPod](https://www.runpod.io). Gearbeitet wird vom Mac aus: Fotos hochladen,
rechnen und die Datei zurückholen erledigt ein Befehl. Hintergrund in
[Entscheidung 0007](../../project-documentation/entscheidungen/0007-avatar-weg.md).

> **Noch nicht getestet** (Stand 26.11.2026): gebaut, aber noch nicht auf einem echten Pod ausprobiert.
> Nur der Ablauf auf dem Mac ist mit einem nachgebauten ssh durchgespielt. Beim ersten `make lhm-setup` kann
> es nötig sein, Versionen nachzubessern.

## Einmal einrichten

1. **Konto:** bei RunPod registrieren und etwas Guthaben laden (für Tests reichen wenige Dollar).
2. **SSH-Schlüssel:** den öffentlichen Schlüssel (`cat ~/.ssh/id_ed25519.pub`) unter *Settings → SSH
   Public Keys* eintragen. Ohne Schlüssel zuerst `ssh-keygen -t ed25519`.
3. **Network Volume:** unter *Storage* ein Volume anlegen, etwa 50 GB, in einer Region mit passenden
   GPUs. Darauf liegen LHM++, die Python-Umgebung und die Modelle; es bleibt, wenn der Pod weg ist.
4. **Pod starten:** *Deploy* mit dem Volume, GPU ab 8 GB (z. B. RTX A4000, RTX 4090), Vorlage mit
   **CUDA 12.1 devel**, z. B. `runpod/pytorch:2.x-py3.10-cuda12.1.1-devel-ubuntu22.04`. Bei *Expose TCP
   Ports* muss 22 dabei sein (bei den RunPod-Vorlagen Standard).
5. **Verbindung eintragen:** beim Pod unter *Connect → SSH over exposed TCP* stehen Adresse und Port.

   ```sh
   cp scripts/runpod/pod.env.example scripts/runpod/pod.env   # dann POD_HOST und POD_PORT eintragen
   make lhm-check                                              # GPU und Speicher anzeigen
   ```

6. **LHM++ installieren:** `make lhm-setup`. Dauert etwa 20 bis 40 Minuten (Pakete, CUDA-Erweiterungen,
   einige GB Modelle) und endet mit einem Probelauf auf den Beispielbildern von LHM++. Das Log liegt auf
   dem Pod unter `/workspace/lhm-setup.log`. Ein zweiter Lauf überspringt, was schon da ist.

## Avatar erzeugen

```sh
make lhm FOTOS=~/Desktop/fotos-beniam            # Name = Ordnername
make lhm FOTOS=~/Desktop/fotos-beniam NAME=beniam
```

Ergebnis: `data/lhm/<name>/avatar.ply`. Fotos als JPG, PNG oder HEIC (wird auf dem Mac umgewandelt),
höchstens 16.

**Gute Fotos** (laut LHM++): 4 bis 8 Stück rundherum (vorne, Seiten, hinten, schräg), hoch aufgelöst,
gleiches Licht, ganze Person im Bild, Hände gut sichtbar, mindestens eines mit ausgebreiteten Armen
(A-Pose wie in [`docs/drehbuch-brush.md`](../../docs/drehbuch-brush.md)).

## Danach: Pod stoppen

Im RunPod-Fenster *Stop*. Dann kostet nur noch das Volume. Beim nächsten Start ist alles noch da, aber
**Adresse und Port ändern sich meist**: in `pod.env` nachtragen.

## Weitere Befehle

```sh
scripts/runpod/lhm.sh ssh     # Shell auf dem Pod, z. B. zum Nachsehen bei Fehlern
```

Auf dem Pod liegt alles unter `/workspace`: `LHM-plusplus/` (Code, `.venv`, `pretrained_models/`),
`lhm-jobs/<name>/` (hochgeladene Fotos und Ergebnis), `cache/`.

## Wenn etwas schiefgeht

- **`nvcc fehlt` oder Fehler beim Bauen von `pointops`, `diff-gaussian-rasterization`:** Vorlage ohne
  CUDA-devel oder mit anderer CUDA-Version. Pod mit einer `cuda12.1...-devel`-Vorlage neu starten.
- **Pakete neu installieren:** auf dem Pod `rm /workspace/LHM-plusplus/.venv/.splattwin-ok`, dann
  `make lhm-setup`.
- **Verbindung abgelehnt:** Pod läuft nicht, oder Adresse und Port in `pod.env` sind veraltet.

## Lizenz

LHM++ steht unter Apache-2.0. Die mitgeladenen SMPL-X-Modelldateien sind nur für Forschung und Studium
freigegeben, dafür braucht es ein eigenes Konto auf https://smpl-x.is.tue.mpg.de.
