# Verlauf

Neueste Einträge oben. Pro Eintrag: Datum, was passiert ist, Links.

## 27.11.2026: Rektifizierung und Genauigkeit des Zwei-Kamera-Trackings

Erkenntnisse und Messungen zusammengefasst in [`docs/notizen-stereo-tracking.md`](../docs/notizen-stereo-tracking.md).

- Tracking-Seite: «Rektifizierte Ansicht und Genauigkeit» unter «Zweite Kamera». Zeigt beide Bilder
  rektifiziert mit Epipolarlinien, den Zeilenversatz gleicher Gelenke und die geschätzte Tiefengenauigkeit
  an der Hüfte samt nötigem Kameraabstand für ±2 cm. Begründung, warum kein dichtes neuronales Stereo:
  Entscheidung 0010
- Stereo-Status nennt jetzt auch den Winkel zwischen den Kameras und warnt, wenn eine fast hinter der
  anderen steht
- Ruhigeres Tracking: adaptiver One-Euro-Filter nach Kalman/EKF, Regler «Glättung» auf der Tracking-Seite
- Handy (Kamera B) mit dem genaueren Modell «heavy» und eigener Fingererkennung; sieht die Webcam eine
  Hand nicht, kommen die Finger vom Handy
- Erkennung von Kamera B in einem Hintergrund-Strang. Gemessen mit Testvideo (30 Bilder/s, Chrome ohne
  Fenster): Webcam 30 und Handy 27 bis 30 Bilder/s. Beide im Hintergrund nur 16 bis 20, weil sich zwei
  Stränge um die GPU streiten
## 27.11.2026: Eigenes Video, LHM-Avatar daraus, ExAvatar eingerichtet

- Neues Video (60 s, iPhone, feste Kamera, Drehung, Hände, Bewegung). Für ExAvatar nach SDR umgewandelt.
- LHM++ aus 13 Standbildern der Drehung: deutlich besser als die alte Aufnahme
  (`tracking.html?run=lhm-beni&src=/runs/_video/beni.mp4`).
- ExAvatar als pod-do-Umgebung und -Aufgabe (`setup-exavatar.sh`, `exavatar_modelle.sh`,
  `exavatar_export.py`). Umgebung eingerichtet und mit einem Probelauf geprüft. Ein eigener Export bringt
  den Avatar in dasselbe Format wie LHM++. Der erste echte Lauf wartet auf die Körpermodelle (SMPL-X,
  FLAME, SMPL), die eigene Konten brauchen.

## 26.11.2026: LHM++ auf RunPod, Werkzeug pod-do

- LHM++ als erster Test für den Avatar-Weg auf SMPL-X (Entscheidung 0007), gerechnet auf RunPod
- Eigenes Werkzeug [pod-do](https://github.com/slackers-dev/pod-do) für GPU-Aufgaben, auch für andere
  Projekte. Begründung in Entscheidung 0008. Aufgaben in `pod-do.toml`, Anleitung in
  [`scripts/pod-do/README.md`](../scripts/pod-do/README.md).
- Erster echter Lauf auf einer L4: LHM++ erzeugt aus den 8 Beispielbildern ein T-Pose-PLY (160 000
  Gaussians). Unterwegs behoben: PATH für nvcc in SSH-Sitzungen, Paketquellen, chumpy, flash-attn (ohne
  über 24 GB Speicher), fester Modellpfad.
- LHM-Avatare bewegen sich über ihr SMPL-X-Skelett statt über den Roboter: `lhm_export.py` schreibt auf
  dem Pod die Gewichte von LHM++ mit, `smplx-avatar.ts` verformt damit im Browser. Neuer Vertrag
  `run-smplx`. Getestet mit einer alten Drehaufnahme (`tracking.html?run=lhm-scan1232&src=...`).
- Recherche: Avatar mit generativer KI verfeinern. Vorschlag in Entscheidung 0009 (offen), Notizen in
  [`docs/notizen-genai-verfeinerung.md`](../docs/notizen-genai-verfeinerung.md).
- pod-do kann die eingerichtete Umgebung als Docker-Image in einer Registry ablegen (`docker` in
  `pod-do.toml`, für LHM++ `ghcr.io/slackers-dev/splattwin-lhm`). Neue Pods starten dann direkt daraus.
  Braucht einen GitHub-Token mit `write:packages` (noch nicht eingerichtet).

## 25.11.2026: Neuaufbau, Bühne, Drehbücher

- Projektstruktur neu aufgebaut und nach `main` gemerged (PR #1). Begründung in
  [`docs/projektstruktur.md`](../docs/projektstruktur.md), Entscheidungen 0001 bis 0006.
  - Web-Teil in TypeScript mit Vite, Vitest und ESLint, Mathematik in `web/src/core` mit Tests
  - Python als Paket `splattwin` mit einer CLI, Server auf FastAPI
  - Datenformate als JSON-Schema in `contracts/`
  - Makefile als gemeinsamer Einstieg, CI auf GitHub Actions
- Bühne mit zwei Presentern, Folien, Regie und Presenter-Login (`feat/buehne`)
- Drehbücher für Aufnahmen mit Brush und ExAvatar (PR #2):
  [`docs/drehbuch-brush.md`](../docs/drehbuch-brush.md),
  [`docs/drehbuch-exavatar.md`](../docs/drehbuch-exavatar.md)
- Recherche zu Splat-Bibliotheken: Spark bleibt der Renderer, LHM und HumanGS als mögliche
  Alternativen zu ExAvatar notiert (siehe Entscheidung 0007)
- Logo und App-Icons

## 20.11.2026: Erster Stand und Ursache der unscharfen Splats

- Erster Commit: Web-Viewer, Splat-Pipeline, Mac- und iPhone-App
- Live-Avatar mit Roboter-Overlay, Nur-Oberkörper-Modus und Live-Übertragung
- Neue App-Aufnahmen wurden unschärfer als das erste Handy-Video. Ursache: zu lange Drehung, die Person
  ist nicht starr. Regeln für starre Aufnahmen und Plan für den SMPL-Weg in
  [`docs/notizen-smpl-avatar.md`](../docs/notizen-smpl-avatar.md)
- Aufnahme mahnt zu langsame Drehung an, Pipeline-Option `--focal` (noch nicht automatisch aktiv)
