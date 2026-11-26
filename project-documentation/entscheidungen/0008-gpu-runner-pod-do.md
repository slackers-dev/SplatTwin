# 0008: GPU-Aufgaben mit pod-do auf RunPod

- **Status:** angenommen
- **Datum:** 26.11.2026
- **Beteiligt:** Benjamin, mit Claude

## Ausgangslage

LHM++ und später ExAvatar brauchen eine Nvidia-GPU, gerechnet wird auf einem gemieteten Pod bei RunPod.
Der erste Weg (`scripts/runpod/`, nie auf einem echten Pod gelaufen) setzte ein Network Volume voraus. Das
hängt an einem Rechenzentrum, und dort waren am 26.11.2026 fast alle GPUs knapp («Low») oder gar nicht
verfügbar. Dazu musste nach jedem Neustart Adresse und Port von Hand in `pod.env` nachgetragen werden.

## Entscheidung

Ein eigenes kleines Werkzeug, [pod-do](https://github.com/slackers-dev/pod-do), auch für andere Projekte.
Es startet einen Pod mit der ersten freien GPU aus einer Liste, in jeder Region. Die Umgebung wird einmal
eingerichtet und als Archiv auf einem **Global Volume** gesichert (nicht an eine Region gebunden, die ersten
100 GB gratis). Danach rechnet es Aufgaben aus `pod-do.toml` und holt die Ergebnisse. Ein Wächter löscht
den Pod bei Leerlauf.

## Betrachtete Alternativen

- **SkyPilot:** ausgereift, sucht die billigste GPU über mehrere Clouds und stoppt bei Leerlauf. Aber gross,
  mit eigenem Server, und ohne RunPod-Volumes. Ohne Volume läuft das Setup (30 Minuten) auf jedem Pod neu,
  oder es braucht ein eigenes Docker-Image mit Registry.
- **dstack:** kann RunPod-Network-Volumes, damit aber wieder an ein Rechenzentrum gebunden.
- **runpodctl:** offizielles Kommandozeilen-Werkzeug, nur ein Baustein (Pods anlegen und löschen).
- **Beim Skript mit Network Volume bleiben:** an knappe GPUs in einer Region gebunden, Verbindung von Hand.

## Folgen

- `scripts/runpod/` fällt weg, an seine Stelle treten `pod-do.toml` und `scripts/pod-do/`.
- Wer Aufgaben auf RunPod rechnen will, installiert pod-do und braucht einen eigenen API-Schlüssel.
- Global Volumes kennen keine Dateirechte, kein atomares Umbenennen und keine Dateisperren. Darum liegt die
  Umgebung samt Modellen als Archiv dort und wird auf die lokale Disk des Pods entpackt.
- pod-do ist noch nicht gegen das echte RunPod getestet, nur gegen einen lokalen Container mit SSH.

## Quellen

- pod-do: https://github.com/slackers-dev/pod-do
- RunPod REST API v2: https://api.runpod.io/v2/openapi.json
- Global Volumes: https://docs.runpod.io/storage/globalvolume
- SkyPilot: https://github.com/skypilot-org/skypilot, dstack: https://dstack.ai/blog/volumes-on-runpod/
