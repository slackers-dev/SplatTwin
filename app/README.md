# Splattwin-App für iPhone und Mac

Zwei native Apps, die die Aufnahme für den Gaussian Splat steuern und das iPhone zur Kamera für das
Live-Tracking machen. Anforderungen: [`../docs/app-anforderungen.md`](../docs/app-anforderungen.md), Stand der
Umsetzung dort in Abschnitt 12.

- **Splattwin Kamera** (iPhone): stellt die Kamera bereit, führt aus, was der Mac verlangt, zeigt gross
  an und sagt an, was zu tun ist. Rechnet nichts.
- **Splattwin** (Mac): koppelt die Handys, zeigt die Livebilder, stellt jede Kamera ein, führt durch die
  Aufnahme, holt die Dateien ab, startet die Pipeline und reicht die Kameras an die Tracking-Seite im
  Browser weiter.

Alles läuft lokal: kein Konto, kein Internetdienst, kein App Store. Internet braucht nur die
Körpererkennung, um beim Start das MediaPipe-Modell zu laden (wie `capture.html`).

## Bauen und starten

Voraussetzung: Xcode 26. Für Pipeline und Seiten den Projektordner einrichten (`make setup`, siehe
[`../README.md`](../README.md)): die App startet `uv run splattwin process` und `splattwin serve`.

```sh
cd app
open Splattwin.xcodeproj
```

- **Mac:** Schema «Splattwin» wählen, ▶. Oder im Terminal:
  `xcodebuild -project Splattwin.xcodeproj -scheme Splattwin -derivedDataPath build build`
  und danach `open "build/Build/Products/Debug/Splattwin.app"`.
- **iPhone:** Handy per Kabel anschliessen, entsperren, «Diesem Computer vertrauen». Einmalig am Handy
  unter Einstellungen › Datenschutz & Sicherheit den Entwicklermodus einschalten. In Xcode das Schema
  «SplattwinKamera» und das Handy als Ziel wählen, ▶. Beim ersten Start am Handy Kamera und lokales Netz
  erlauben.

Auf einem anderen Rechner als dem von Benjamin: in `Local.xcconfig` das eigene Entwicklerteam und einen
eigenen Präfix eintragen. Nach dem Hinzufügen oder Löschen von Quelldateien `xcodegen generate` ausführen
(`brew install xcodegen`); das Projekt wird aus `project.yml` erzeugt.

## Benutzen

1. Am iPhone «Splattwin Kamera» öffnen. Oben rechts steht ein sechsstelliger Kopplungscode.
2. Am Mac «Splattwin» öffnen. Unter **Kameras** erscheint das Handy unter «Geräte im Netz»: Code
   eintragen, «Koppeln». Der Mac merkt sich den Code und verbindet beim nächsten Mal von selbst.
3. Kamera anklicken: rechts lassen sich Linse, Auflösung, Belichtung, Fokus, Weissabgleich und das
   Livebild einstellen. Doppelklick zeigt das Bild gross.
4. **Aufnahme:** Steht die Kamera an ihrem Platz, «Einrichten und sperren» drücken: Belichtung, Fokus und
   Weissabgleich pendeln sich ein und werden festgehalten. Im Bild prüfen, ob Helligkeit und Farben stimmen.
   Bei «Ansage» wählen, ob Mac, Handy oder beide sprechen, und mit «Testen» ausprobieren.
   Dann Name und Körpergrösse eintragen, «Aufnahme starten», den Ansagen folgen. **Körper:** aus dem Bild
   gehen, hineinkommen und zur Kamera A schauen, eine zügige, gleichmässige Drehung (etwa 20 s, Arme ruhig), danach 20 Sekunden frei bewegen.
   **Gesicht** (eigene Aufnahme, Umschalter oben): nah an die Kamera setzen, Kopf geführt zur einen Seite,
   zur anderen und zurück. Beim Start stellt die App die Handys selbst auf Hauptkamera, 4K und hochkant
   und sperrt Belichtung und Farben. Danach holt der Mac die Dateien und zeigt «Splat rechnen».
5. **Aufnahmen:** Pipeline starten, Fortschritt und Qualitätsbericht ansehen, Splat im Browser öffnen,
   `splat.ply`, `splat.json` und `rig.json` exportieren.
6. **Tracking:** «Live-Avatar öffnen». Auf der Seite erscheinen die Kameras der App in den Kameralisten
   als «Splattwin: …». Gemessenen Kameraabstand in der App eintragen, dann auf der Seite kalibrieren.

Ohne Handy lässt sich alles mit «Hinzufügen › Videodatei als Kamera» oder «Testbild» ausprobieren.

**Per USB-Kabel statt WLAN:** iPhone mit dem Kabel an den Mac hängen (einmal «Vertrauen» bestätigen),
die App auf dem iPhone offen lassen. Der Mac findet das Handy über den USB-Dienst von macOS (usbmuxd) und
wechselt von selbst auf das Kabel. Die Kachel zeigt dann «· Kabel». Kabel abziehen: zurück ins WLAN.
Die Verbindung ist gleich verschlüsselt und steuert die Kamera gleich wie im WLAN, nur ohne Router dazwischen.
Auf dem Handy wartet die App dafür auf den Anschlüssen 48931 (Verbindung) und 48930 (Name), nur lokal
erreichbar (`USBLink.swift`).

## Aufbau

```
app/
  Kit/        Gemeinsamer Code (Swift-Paket) für beide Apps, mit Tests
    Models.swift        Einstellungen, Zustand, Nachrichten
    Wire.swift          Pakete auf der Leitung, Verschlüsselung, Uhrenabgleich
    CameraSource.swift  Kamera: Linse wählen, alles Automatische sperren, Kameradaten pro Bild
    Frames.swift        Livebild als JPEG, Aufnahme als HEVC, Testbild, Videodatei als Kamera
    CameraNode.swift    Kameraseite: Befehle ausführen, senden, aufnehmen, Dateien herausgeben
    RemoteCamera.swift  Mac-Seite: Geräte finden, verbinden, fernsteuern, Dateien abholen
    Flow.swift          Geführter Ablauf als Zustandsmaschine
    WebBridge.swift     Brücke zum Browser (WebSocket auf 127.0.0.1:8932)
    CaptureStore.swift  Metadatei, Ablage, Pipeline starten, Qualitätsbericht
  iOS/        iPhone-App
  Mac/        Mac-App; Resources/pose.html ist die Körpererkennung (MediaPipe wie im Prototyp)
../web/src/tracking/app-bridge.ts   Bindet die Kameras der App in die Tracking-Seite ein
```

**Verbindung.** Das Handy bietet im lokalen Netz einen Dienst an (Bonjour, `_splattwin._tcp`), der Mac
findet ihn. Die Verbindung ist mit TLS verschlüsselt; der Schlüssel entsteht aus dem Kopplungscode. Ohne
Code kommt keine Verbindung zustande. Livebild und Steuerung teilen sich eine Verbindung, Dateien
laufen über eine zweite, damit das Livebild beim Übertragen nicht stockt.

**Livebild.** Jedes Bild ist ein eigenes JPEG mit Aufnahmezeit, Bildnummer und Kameradaten. Kommt die
Leitung nicht nach, werden Bilder verworfen statt gestaut, damit die Verzögerung nicht wächst. JPEG statt
eines Videocodecs, weil ein verlorenes Bild so keine Folgen für die nächsten hat und der Browser die
Bilder ohne Umrechnen lesen kann. Preis: etwa 15 bis 25 Mbit/s bei 1280 Pixeln und 30 Bildern.

**Uhren.** Der Mac misst wie bei NTP laufend den Abstand zur Uhr jedes Geräts und nimmt die Messung mit
der kürzesten Laufzeit. Damit starten alle Kameras auf dasselbe Signal, und jedes Livebild und jedes
aufgenommene Bild hat eine Zeit auf der Uhr des Macs.

**Aufnahme.** Auf dem Gerät als HEVC mit etwa 60 Mbit/s bei 4K, Rec. 709, ohne Ton. Daneben eine Datei
`<name>_<kamera>.frames.json` mit der Zeit jedes Bildes, den Kameradaten pro Bild, allen Einstellungen
und der Schwerkraftrichtung. Auf dem Mac landet alles in `data/captures/`, die Metadatei
`<name>.json` folgt dem Vertrag `contracts/capture.schema.json`, wie die von `capture.html`, und hat
zusätzlich einen Teil `app`.

**Körpererkennung.** Dieselbe MediaPipe-Erkennung wie in `capture.html`, in einer unsichtbaren
Webansicht der Mac-App. Apples eigene Körpererkennung wurde geprüft und verworfen: am Video `scan-2101`
zählte sie 0° statt 355°, weil sie das Skelett in einer festen Körperlage liefert.

## Tests

```sh
cd app/Kit && swift test
```

20 Tests: Pakete, Uhrenabgleich, Kopplung mit falschem Code, Livebild, Aufnahme und Dateiübertragung
über die echte verschlüsselte Verbindung (Kameraseite und Mac-Seite im selben Prozess), Wiederverbinden,
der geführte Ablauf mit nachgestellten Beobachtungen, Metadatei, Qualitätsbericht, Brücke zum Browser.

Ganzer Durchlauf der Mac-App ohne Kamera, mit einem Video als Kamera:

```sh
build/Build/Products/Debug/Splattwin.app/Contents/MacOS/Splattwin \
  --video ../data/captures/scan-2101_a.mp4 --auto --name apptest
```

Weitere Schalter: `--testbild`, `--ohne-gesicht`, `--nur-gesicht`, `--pose-log <Datei>`.
