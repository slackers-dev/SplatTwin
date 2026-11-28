# Verlauf

Neueste Einträge oben. Pro Eintrag: Datum, was passiert ist, Links.

## 28.11.2026: In die Knie gehen, ExAvatar auf der Bühne

- Der Avatar folgt der Höhe der Hüfte: in die Knie gehen senkt ihn, die Beine knicken per IK ein, die
  Füsse bleiben auf dem Boden, auch wenn die Kamera die Beine nicht sieht (Laptop). Springen hebt ihn.
  Begründung und Messungen in Entscheidung 0011. Schalter «In die Knie gehen» auf der Tracking-Seite.
- Live-Format Version 2 mit der Höhe, damit auch die Bühne mitgeht.
- Behoben: Der Avatar verschwand auf der Tracking-Seite, wenn das Video mit einer hereinlaufenden Person
  begann. Der Nullpunkt kam vom ersten, halb erkannten Bild (15 m entfernt) und stellte den Avatar hinter
  die Kamera. Nullpunkt und Höhenbezug gelten jetzt erst, wenn die Messung ruhig ist (`core/settle.ts`).
- Zuschauer über das Internet dürfen jetzt `smplx.json` und `smplx_skin.bin` laden, sonst sahen sie
  statt des ExAvatars nichts Brauchbares.
- Geprüft mit dem eigenen Video (`tracking.html?run=exavatar-beni&src=/runs/_video/beni.mp4`) und auf
  der Bühne mit Live-Übertragung.
- Behoben: Auf der Bühne kippte der Avatar beim Wegdrehen um oder lag waagrecht in der Luft. Die Bühne
  blendet zwischen zwei Live-Bildern über; vertauscht die Erkennung links und rechts, fielen Schultern und
  Hüften im Zwischenbild auf einen Punkt. Springt der Rumpf, gilt jetzt direkt das neue Bild (`core/blend.ts`).
- Tracking-Seite: Schalter «Bühnenansicht» zeigt die echte Bühne als Vorschau im selben Fenster. Ein
  zweites Fenster mit der Bühne verdeckte die Tracking-Seite, Chrome drosselte sie samt MediaPipe
  (Erkennung 400 bis 900 ms statt 30 ms), auf der Bühne kamen nur 2 Bilder/s an. Mit dem Schalter etwa 25.
- Ein Takt aus einem Worker treibt das Tracking weiter, wenn Chrome die Animationsschleife drosselt; die
  Bühne zeigt einen Presenter erst nach 5 s ohne Bild als offline (vorher 2 s).
- Bühne spielt die Live-Bilder jetzt mit einem kleinen Puffer im Takt des Senders ab (60 bis 250 ms
  Verzögerung, je nach Schwankung der Laufzeit) statt ab Ankunft überzublenden. Unregelmässig ankommende
  Bilder liessen den Avatar sonst zucken.
- Kopf und Mund: MediaPipe Face Landmarker auf einem vergrösserten Kopfausschnitt (im ganzen Bild ist
  das Gesicht ab etwa 2 m zu klein). Der Kopf folgt der Drehung des Gesichtsmodells statt Nase und Ohren,
  der Kiefer des SMPL-X-Skeletts öffnet sich mit `jawOpen` (ExAvatar hat dafür rund 38 000 Kleckse am
  Kiefer, auch den Mundinnenraum). Von hinten bleibt es bei Nase und Ohren. Live-Format: 9 Bytes mehr.
  Schalter «Kopf und Mund (Gesichtsmodell)», kostet etwa 7 ms pro Bild.

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
  den Avatar in dasselbe Format wie LHM++.
- Erster ExAvatar-Lauf auf einer L4: rund 9 h (Fitting 1.5 h, Training 6 h für 5 Epochen), etwa $7.
  Ergebnis 167 000 Gaussians, Gesicht und Kleidung deutlich schärfer als LHM++
  (`tracking.html?run=exavatar-beni&src=/runs/_video/beni.mp4`). Unterwegs behoben: libGLU für pyrender,
  Höchstdauer des Pods (jetzt 10 h), Importreihenfolge im Export. `snapshot_4.pth` liegt unter
  `data/exavatar/beni/avatar/`, ein neuer Export braucht kein neues Training.

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
