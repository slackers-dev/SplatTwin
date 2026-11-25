# Splattwin: Anforderungen an die App für Handy und Mac (Aufnahme und Live-Tracking)

Arbeitsname des Projekts: **Splattwin** (provisorisch, 19.11.2026).

Ziel: Eine eigene App auf dem iPhone und eine auf dem Mac, mit denen wir die Aufnahme für den
Gaussian Splat einer Person vollständig selbst steuern, statt über Browser und Integrationskamera.

Dieselbe App soll das Handy auch zur Kamera für das Live-Tracking machen (zweite Ansicht für die
Triangulation). Die Anforderungen dazu stammen aus der Tracking-Sitzung und stehen in Abschnitt 9
sowie als H-16 bis H-19 und M-16 bis M-20 (zusammengeführt am 19.11.2026).

**Für alle, die dieses File ergänzen:** Neue Punkte unten in den passenden Abschnitt anhängen und
die nächste freie Nummer vergeben (z. B. `H-15`). Bestehende Nummern nicht ändern. Priorität:
**Muss** (ohne das lohnt sich die App nicht), **Soll** (deutlicher Gewinn), **Kann** (später).
Entscheide stehen in Abschnitt 7, offene Fragen in Abschnitt 8.

## 1. Warum eine eigene App

Der Browser-Prototyp (`capture.html`, `splat/splat_pipeline.py`) funktioniert, stösst aber an Grenzen,
die sich im Browser nicht beheben lassen:

| Grenze im Prototyp | Folge |
|---|---|
| Browser liefert Handy und Webcam nur mit 1280×720 im Querformat | Person ca. 400 px hoch, Gesicht nur 40–50 px |
| Belichtung, Fokus und Weissabgleich nicht sperrbar | Hintergrundvergleich und Farben schwanken |
| Starke Kompression durch den Browser-Rekorder | weniger Merkmale für COLMAP, unscharfer Splat |
| Videostabilisierung und HDR nicht abschaltbar | Brennweite ändert sich pro Bild, Farben falsch |
| Keine Kameradaten vom Gerät (Brennweite, Verzeichnung, Tiefe) | alles muss geschätzt werden |
| Zwei Kameras nur ungefähr gleichzeitig gestartet | Versatz von einigen Millisekunden bis Bildern |

Beim Live-Tracking über Apples Integrationskamera kamen diese Grenzen dazu:

| Grenze im Tracking | Folge |
|---|---|
| Linse lässt sich vom Browser aus nicht wählen (kein Ultraweitwinkel) | zu wenig Platz im Raum, ganzer Körper passt nicht ins Bild |
| Kameradaten unbekannt | Schachbrett-Kalibrierung von Hand, bei jedem Linsenwechsel neu |
| Aufnahmezeit pro Livebild unsicher, Kameras nicht synchron | Fehler bei schneller Bewegung |
| Center Stage und Automatik ändern den Bildausschnitt laufend | Kalibrierung wird ungültig |
| Lage und Abstand der Kameras nur geschätzt, Massstab aus angenommener Körpergrösse | Distanzen ungefähr, Stereo-Fehler zuletzt 6,2 Pixel |
| Verbindung ist eine Blackbox (schwarzes Bild, Kamera taucht nicht auf) | Fehlersuche durch Raten |

## 2. Handy-App (Aufnahme)

| Nr. | Anforderung | Priorität | Warum |
|---|---|---|---|
| H-1 | Aufnahme in voller Sensorauflösung (4K), Hochformat, 30 fps, hohe Bitrate (HEVC) | Muss | Mehr Pixel auf der Person, vor allem im Gesicht |
| H-2 | Belichtung (ISO, Verschlusszeit), Fokus und Weissabgleich fest einstellen und sperren | Muss | Gleichbleibendes Bild über die ganze Drehung |
| H-3 | Kurze Verschlusszeit wählbar (z. B. 1/200 s) | Muss | Weniger Bewegungsunschärfe beim Drehen |
| H-4 | HDR aus, fester Farbraum (SDR, Rec. 709) | Muss | Farben werden sonst falsch umgerechnet |
| H-5 | Videostabilisierung aus, feste Linse (1×), kein automatischer Linsenwechsel | Muss | Stabilisierung ändert Bildausschnitt und Brennweite pro Bild |
| H-6 | Vom Mac fernsteuerbar: Einstellungen, Start, Stopp, Phasenwechsel | Muss | Niemand steht am Handy, die Person ist im Bild |
| H-7 | Live-Vorschau in niedriger Auflösung an den Mac senden | Muss | Körpererkennung und Kontrolle laufen am Mac |
| H-8 | Aufnahme in voller Qualität nach dem Stopp automatisch auf den Mac übertragen | Muss | Kein AirDrop von Hand |
| H-9 | Zeitstempel pro Bild auf einer mit dem Mac abgeglichenen Uhr speichern | Muss | Bildgenaue Synchronisation mehrerer Kameras |
| H-10 | Kameradaten vom Gerät pro Aufnahme speichern: Brennweite, Bildmittelpunkt, Verzeichnung | Soll | COLMAP muss weniger schätzen, Proportionen stimmen |
| H-11 | Schwerkraftrichtung (Lagesensor) speichern | Soll | «Oben» im Splat ohne Umweg über die Kamerabahn |
| H-12 | Tiefenbilder mitspeichern, falls das Gerät LiDAR oder TrueDepth hat | Kann | Echter Massstab in Metern, bessere Startpunkte fürs Training |
| H-13 | Grosse Statusanzeige (Farbe, Text) und Sprachansage auf dem Handy | Soll | Aus drei Metern erkennbar, was zu tun ist |
| H-14 | Prüfung vor der Aufnahme: Speicherplatz, Akku, Temperatur | Soll | 4K-Aufnahmen brechen sonst mittendrin ab |
| H-15 | Modus «Gesichtsscan»: Nahaufnahme von Kopf und Schultern mit eigenen Einstellungen | Soll | Scharfes Gesicht, siehe Abschnitt 4 |
| H-16 | Linse wählbar: Ultraweitwinkel (0,5×), Hauptkamera (1×), Tele, Frontkamera; danach fest wie in H-5 | Muss | Tracking braucht in kleinen Räumen das Ultraweitwinkel; für die Splat-Aufnahme bleibt 1× der Normalfall |
| H-17 | Center Stage und jede automatische Änderung des Bildausschnitts aus | Muss | Sonst wird die Kalibrierung im Livebetrieb sofort ungültig |
| H-18 | Bewegungssensor meldet, wenn das Handy verschoben wurde («neu kalibrieren») | Soll | Eine verrutschte Kamera fällt sonst erst an falschen 3D-Punkten auf |
| H-19 | Handy bleibt während Übertragung und Aufnahme wach, Bildschirm abgedunkelt | Muss | Sonst bricht der Stream ab; Akku und Hitze |

## 3. Mac-App (Steuerung, Prüfung, Verarbeitung)

| Nr. | Anforderung | Priorität | Warum |
|---|---|---|---|
| M-1 | Handys im Netz finden und koppeln, Verbindung über WLAN oder Kabel | Muss | Grundlage für alles Weitere |
| M-2 | Mehrere Kameras gleichzeitig steuern (mehrere Handys, optional die Mac-Webcam) | Muss | Mehr Höhen ergeben saubereren Kopf und Schultern |
| M-3 | Uhren aller Geräte abgleichen, alle Aufnahmen auf dasselbe Signal starten | Muss | Synchronisation ohne Klatschen |
| M-4 | Geführter Ablauf mit Körpererkennung: leerer Raum, Pose, Drehung, Stopp (wie `capture.html`) | Muss | Hat sich im Prototyp bewährt |
| M-5 | Live-Prüfung pro Kamera: ganz im Bild, Grösse im Bild, Blickrichtung, stillstehen | Muss | Fehler vor der Aufnahme statt nach dem Rechnen |
| M-6 | Drehwinkel und Drehgeschwindigkeit mitzählen, bei 360° automatisch stoppen | Muss | Im Prototyp vorhanden und getestet |
| M-7 | Warnung, wenn Arme, Kopf oder Füsse sich während der Drehung bewegen | Soll | Bewegung ist die Hauptursache für verwaschene Stellen |
| M-8 | Prüfung der Szene vor dem Start: Helligkeit, Flimmern des Lichts, Schärfe, Kontrast zum Hintergrund | Soll | Schlechte Bedingungen früh melden |
| M-9 | Aufnahmen verwalten: Name, alle Zeiten und Einstellungen in einer Metadatei, Wiederholen | Muss | Jede Aufnahme muss ohne Nachfragen neu rechenbar sein |
| M-10 | Pipeline per Knopf starten, Fortschritt und Qualitätsbericht anzeigen (registrierte Bilder, Kamerabahn, Brennweiten) | Muss | Heute ein Befehl im Terminal |
| M-11 | Rechnen wahlweise auf dem Mac oder auf einem Rechner mit Nvidia-Karte | Soll | Voraussetzung für bessere Avatar-Methoden |
| M-12 | Farbabgleich zwischen den Kameras | Soll | Verschiedene Kameras geben Farben verschieden wieder, sonst Flecken im Splat |
| M-13 | Kamerakalibrierung pro Gerät speichern und wiederverwenden (Schachbrett existiert in `server.py`) | Soll | Für die Webcam, die keine Gerätedaten liefert |
| M-14 | Ergebnis ansehen: Splat drehen, Läufe vergleichen, Avatar mit Live-Tracking testen | Soll | Heute `splat.html` und `index.html` |
| M-15 | Export: Splat-Datei, Ausrichtung, Gelenke (`splat.ply`, `splat.json`, `rig.json`) | Muss | Schnittstelle zur Avatar-Seite |
| M-16 | Verbindungszustand pro Kamera anzeigen: verbunden, Bildrate, Auflösung, verlorene Bilder, Bildhelligkeit | Muss | Fehlersuche ohne Raten (schwarzes Bild, fehlende Kamera) |
| M-17 | Abgebrochene Verbindung baut sich von selbst wieder auf, Einstellungen bleiben erhalten | Soll | Tracking läuft über lange Zeit |
| M-18 | Dieselbe Kamerasteuerung für die eingebaute Mac-Kamera (Linse, Fokus, Belichtung) | Kann | Im Browser nicht möglich, nur mit nativer Mac-App |
| M-19 | Livebild jeder Kamera gross sichtbar, auch während der Kalibrierung | Muss | Schachbrett muss bis an den Bildrand geführt werden |
| M-20 | Einstellungen pro Aufbau speichern und laden (Linse, Fokus, Belichtung, Kalibrierungen) | Soll | Aufbau am nächsten Tag ohne Neueinrichtung |

## 4. Aufnahme-Ablauf

| Nr. | Anforderung | Priorität | Warum |
|---|---|---|---|
| A-1 | Phase «leerer Raum» pro Kamera, nur gültig, wenn keine Person sichtbar ist | Muss | Hintergrundbild für die Masken |
| A-2 | Phase «Körper»: A-Pose, eine volle Drehung in 25–30 s, starr | Muss | Grundlage des Splats |
| A-3 | Phase «Gesicht»: nah an die Kamera, Kopf und Schultern füllen das Bild, zweite Drehung | Soll | Gesicht hat sonst zu wenig Pixel |
| A-4 | Phase «Hände» (Nahaufnahme) | Kann | Hände sind im Körper-Splat verwaschen |
| A-5 | Kopf-Splat über gemeinsame 3D-Punkte (Nase, Augen, Ohren) auf den Körper-Splat legen | Soll | Zwei Splats haben getrennte Koordinatensysteme |
| A-6 | Jede Phase einzeln wiederholbar, ohne alles neu aufzunehmen | Soll | Spart Zeit bei einem Fehler |
| A-7 | Körpergrösse der Person erfassen | Muss | Massstab des Splats, solange keine Tiefendaten da sind |

## 5. Daten und Qualität

| Nr. | Anforderung | Priorität | Warum |
|---|---|---|---|
| D-1 | Rohaufnahmen unverändert behalten | Muss | Neu rechnen mit besserer Methode muss möglich sein |
| D-2 | Einheitliches Koordinatensystem: y oben, Person schaut nach +z, Meter | Muss | So erwartet es die Avatar-Seite |
| D-3 | Alle Daten bleiben lokal, kein Hochladen ohne ausdrückliche Zustimmung | Muss | Aufnahmen von Personen |
| D-4 | Qualitätsampel pro Aufnahme (gut, brauchbar, wiederholen) aus den Prüfungen | Kann | Schnelle Entscheidung nach der Aufnahme |

## 6. Erkenntnisse aus dem Prototyp

- Feste Kamera und sich drehende Person funktioniert, wenn der Hintergrund maskiert wird: 120 von 120
  Bildern registriert, Kamerabahn 370°.
- Getrennte Brennweiten für Breite und Höhe liefen auseinander (1101 und 1180 px); eine gemeinsame
  Brennweite pro Kamera ist stabiler.
- Gegenstände vor der Person (Stühle) schneiden Füsse ab; bewegte Arme ergeben verwaschene Hände.
- Der Drehwinkel lässt sich aus der Schulterlinie der Körpererkennung zählen (355° gezählt bei einer vollen Drehung).
- Zwei Kameras: im Test mit künstlichen Videos wurden beide Bahnen verbunden und beide Brennweiten
  richtig geschätzt; mit echter Webcam und Handy noch offen.
- Der Splat lässt sich mit den Gewichten des Mixamo-Roboters weich an das Tracking binden (`splat-avatar.js`).
- Über die Integrationskamera liefert der Browser das iPhone höchstens als Querformat 1920×1440 (4:3).
  Ein echtes Hochformat ist nicht wählbar; steht das Handy hochkant, kommt nur ein Ausschnitt an.
  Verlangt man 1920×1080, schneidet der Browser zusätzlich oben und unten ab.
- Die Integrationskamera hat mitten in einer Aufnahme von selbst den Bildausschnitt gewechselt (Zoom-Sprung).
  Die Pipeline erkennt das und schätzt davor und danach getrennte Brennweiten, die Qualität leidet trotzdem.
- Tracking: Die Integrationskamera gibt dem Browser nur das fertige Bild; Linse und Zoom sind von der
  Webseite aus nicht steuerbar, nur über das Video-Menü von macOS.
- Tracking: Die Schachbrett-Kalibrierung über `server.py` traf im Test mit künstlichen Bildern den
  Öffnungswinkel auf 0,2° genau; mit echten Kameras noch nicht ausgewertet.
- Tracking: Erste echte Stereo-Kalibrierung ergab 1,08 m Kameraabstand bei 6,2 Pixeln Fehler, vermutlich
  weil die Mac-Kamera auf 0,5× stand, aber nicht kalibriert war.
- Tracking: Die Kamera-Fusion im Extended Kalman Filter (`ekf.js`) verträgt unterschiedliche Aufnahmezeiten,
  braucht dafür aber genaue Zeitstempel pro Bild. In der Simulation sank der Fehler bei 40 ms Versatz von 5,6 auf 2,3 cm.

## 7. Entscheide

- **Plattform:** nur iOS und macOS, kein Android (entschieden am 19.11.2026).
- **Stellenwert:** Die App ist Kür des Projekts, nicht Teil der Pflichtabgabe (entschieden am 19.11.2026).
  Der Browser-Prototyp bleibt der Weg für die Abgabe, die App darf ihn nicht blockieren.
- **Technik:** native Apps in Swift mit einem gemeinsamen Paket für iOS und macOS, Code in `projekt/app`
  (umgesetzt am 19.11.2026). Vorerst nur lokal gebaut, keine Verteilung.
- **Übertragung:** eigenes Protokoll über eine mit dem Kopplungscode verschlüsselte Verbindung, Livebild als
  einzelne JPEG-Bilder mit Aufnahmezeit und Kameradaten. Kein WebRTC: das hätte eine grosse fremde Bibliothek
  gebraucht, und die Mac-App reicht die Bilder ohnehin an den Browser weiter (19.11.2026).
- **Tracking bleibt im Browser:** `index.html` rechnet weiter wie bisher. Die Mac-App stellt ihre Kameras über
  eine lokale Brücke bereit (`app-kamera.js`), sie erscheinen in der Seite als «Splattwin: …» (19.11.2026).
- **Körpererkennung in der Mac-App:** dieselbe MediaPipe-Erkennung wie in `capture.html`. Apples eigene
  Erkennung zählte am Video `scan-2101` 0° statt 355° und wurde verworfen (19.11.2026).
- **Gesichtsscan nach Zeit statt nach Winkel:** in der Nahaufnahme sind die Schultern kaum im Bild, der Winkel
  liess sich am Video `scan-2101` weder über Schultern noch über Ohren zählen. Die Drehung dauert eine feste
  Zeit (Standard 20 s), die Viertel werden angesagt (19.11.2026).

## 8. Offene Fragen

- Native Apps in Swift mit gemeinsamem Code für iOS und macOS? Naheliegend, weil die Kamerasteuerung aus Abschnitt 2 nativen Zugriff braucht; noch nicht entschieden.
- Welche Handys stehen zur Verfügung, und haben sie LiDAR?
- Wie viele Kameras gleichzeitig sind das Ziel?
- Liefert iOS Brennweite, Bildmittelpunkt und Verzeichnung im normalen Videobetrieb pro Bild, oder nur bei Fotos und mit Tiefendaten? Vor H-10 und T-3 prüfen.
- Übertragungsweg für das Livebild: WebRTC (passt direkt in den Browser) mit Datenkanal für Zeitstempel, Kameradaten und Fernsteuerung, oder ein eigenes Protokoll?
- Bleibt die Mac-Seite fürs Tracking im Browser (`index.html`), oder zieht auch sie in die native Mac-App? Nur M-18 verlangt zwingend nativ.
- Wer testet am Gerät? Claude kann auf dem iPhone nichts selbst ausprobieren, jeder Schritt braucht einen Test von euch.

Beantwortet am 19.11.2026 (siehe Abschnitt 7): Swift mit gemeinsamem Code, eigenes Protokoll statt WebRTC,
Tracking bleibt im Browser. Zu den Kameradaten: iOS liefert Brennweite und Bildmittelpunkt im normalen
Videobetrieb pro Bild, solange die Stabilisierung aus ist; die Verzeichnung liefert es nicht, entfernt sie aber
auf Wunsch schon im Bild. So macht es die App und meldet «entzerrt». Am Gerät noch nachzuprüfen.

## 9. Live-Tracking

Anforderungen, die nur der Livebetrieb stellt. Kamerasteuerung, Uhrenabgleich und Koppeln stehen
bereits in den Abschnitten 2 und 3 (H-2, H-3, H-5, H-6, H-9, H-11, M-1, M-2, M-3).

| Nr. | Anforderung | Priorität | Warum |
|---|---|---|---|
| T-1 | Livebild für das Tracking mit mindestens 30 Bildern pro Sekunde bei 1280×720 und höchstens etwa 100 ms Verzögerung | Muss | Die Vorschau aus H-7 in niedriger Auflösung reicht für die Gelenkerkennung nicht |
| T-2 | Auflösung und Bildrate des Livebilds vom Mac aus umschaltbar (z. B. 60 Bilder pro Sekunde) | Kann | Schnelle Bewegungen |
| T-3 | Kameradaten der aktiven Linse schon beim Verbinden an den Mac schicken, nicht erst mit der Aufnahme (H-10) | Muss | Ersetzt die Schachbrett-Kalibrierung des Handys |
| T-4 | Verzeichnung mitschicken oder ein entzerrtes Bild liefern, und angeben, welches von beidem gilt | Soll | Ultraweitwinkel verzeichnet stark, die Triangulation rechnet mit einer idealen Lochkamera |
| T-5 | Änderung von Linse, Zoom oder Auflösung sofort melden | Soll | Der Mac muss alte Kalibrierungen verwerfen |
| T-6 | Schachbrett-Kalibrierung als Gegenprobe zu den Gerätedaten behalten | Kann | Überprüfung, und Stoff für die Präsentation |
| T-7 | Aufnahmezeitpunkt zu jedem Livebild mitschicken (wie H-9, aber im Stream) | Muss | Der Filter ordnet die Bilder zeitlich ein |
| T-8 | Gesamte Verzögerung von der Aufnahme bis zur Anzeige messen und anzeigen | Soll | Kontrolle der Synchronisation |
| T-9 | Echten Abstand zwischen den Kameras eintragen (Messband), legt den Massstab fest | Muss | Massstab kommt heute aus einer angenommenen Körpergrösse |
| T-10 | Lage der Kameras zueinander aus einem Schachbrett bekannter Grösse, das beide sehen | Soll | Genauer als die Selbstkalibrierung aus den Gelenken |
| T-11 | Abstand per Ton-Laufzeit zwischen den Geräten messen | Kann | Aufwendig und liefert nur die Zahl aus T-9 |
| T-12 | Tiefenbild im Livebetrieb mitschicken, falls LiDAR vorhanden (wie H-12, aber im Stream) | Kann | Tiefe direkt gemessen statt trianguliert |

## 10. Was die App nicht tun soll

- Keine Pose-Erkennung und kein Filter auf dem Handy. Die Computer-Vision-Teile bleiben auf dem Mac, weil sie der bewertete Inhalt des Moduls sind.
- Kein App Store, keine Benutzerkonten, kein Internetdienst (siehe D-3).

## 11. Kleinste sinnvolle erste Version fürs Tracking

1. M-1, M-16, T-1: koppeln, Zustand sehen, Livebild übertragen
2. H-2, H-5, H-16, H-17, H-19: Linse wählen, alles Automatische sperren, Handy bleibt wach
3. T-3: Kameradaten mitschicken
4. M-3, T-7: Uhrenabgleich und Zeitstempel im Stream
5. M-19: Livebild gross auf dem Mac
6. T-9: Eingabefeld für den Kameraabstand (auf dem Mac auch ohne App möglich)

## 12. Stand der Umsetzung (19.11.2026)

Code und Anleitung: `projekt/app` (`README.md`). Beide Apps lassen sich bauen, die iPhone-App ist für ein
echtes Gerät signiert. **Am iPhone ist noch nichts ausprobiert**: alles, was nur das Handy kann, ist
geschrieben, aber ungetestet.

Geprüft auf dem Mac, ohne Handy:

- 20 automatische Tests: Kopplung (auch mit falschem Code), Livebild, Uhrenabgleich, Aufnahme auf ein
  gemeinsames Startsignal, Dateiübertragung mit Prüfsumme, Wiederverbinden mit alten Einstellungen,
  geführter Ablauf, Metadatei, Qualitätsbericht, Brücke zum Browser.
- Ganzer Durchlauf der Mac-App mit dem Video `scan-2101_a.mp4` als Kamera: leerer Raum, Pose und
  Körperdrehung wie im Browser-Prototyp (357° gezählt, Prototyp 355°; Zeitmarken auf 0,2 s gleich).
- Die Aufnahme der App (HEVC, `.mov`) und ihre Zeitmarken wurden von `splat_pipeline.py` bis zu den Masken
  richtig gelesen. Ein ganzer Splat aus einer App-Aufnahme wurde noch nicht gerechnet.
- Tracking-Seite in Chrome: Kamera der App erscheint in der Liste, läuft mit 1280×720, 35 ms von der
  Aufnahme bis in den Browser, Aufnahmezeit pro Bild kommt an.

| Stand | Anforderungen |
|---|---|
| Umgesetzt und auf dem Mac geprüft | H-6, H-7, H-8, H-9, M-3, M-4, M-6, M-9, M-16, M-17, A-1, A-2, A-7, D-1, D-3, T-2, T-5, T-7 |
| Umgesetzt, am iPhone ungetestet | H-1, H-2, H-3, H-4, H-5, H-10, H-11, H-13, H-14, H-16, H-17, H-18, H-19, M-1, M-2, T-1, T-3, T-4 |
| Umgesetzt, nicht durchgespielt | M-5, M-7, M-10 (Knopf startet `process_capture.py`), M-15, M-19, M-20, D-4, T-9 |
| Teilweise | H-15, A-3, A-6, M-8, M-13, M-14, M-18, T-6, T-8 |
| Offen | H-12, M-11, M-12, A-4, T-10, T-11, T-12 |

Zu «Teilweise»:

- H-15, A-3: Der Gesichtsscan ist eine Phase im Ablauf (nach Zeit), hat aber keine eigenen Kameraeinstellungen.
- A-6: Die Phasen sind einzeln wählbar, eine wiederholte Phase ergibt aber eine neue Aufnahme; die Pipeline
  kann Phasen aus zwei Aufnahmen noch nicht zusammensetzen.
- M-8: Nur die Helligkeit wird geprüft, Flimmern, Schärfe und Kontrast noch nicht.
- M-13: Das Handy liefert seine Kameradaten selbst; die Schachbrett-Kalibrierung bleibt in der Browser-Seite
  und wird dort gespeichert, nicht in der App.
- M-14: Die App öffnet `splat.html` und `index.html` im Browser; Läufe vergleichen gibt es nicht.
- M-18: Die Mac-Kamera lässt sich hinzufügen und sperren, feste Werte gibt es nur am Handy. Ungetestet.
- T-6: Das Schachbrett bleibt in der Seite nutzbar und überschreibt dann die Gerätedaten.
- T-8: Die App zeigt die Verzögerung bis zum Mac; bis zur Anzeige im Browser misst `app-kamera.js` sie
  (`stream.splattwin.latency`), die Seite zeigt sie noch nicht an.

Bekannte Grenzen: Verbindung über WLAN oder direkt zwischen den Geräten, ein eigener Weg übers Kabel fehlt.
4K bringt der Pipeline erst etwas, wenn `process_capture.py` mehr als 1920 Pixel durchlässt. Die
Körpererkennung braucht beim Start Internet für das Modell. Der Kopplungscode hat sechs Ziffern: genug gegen
Mitsehen im WLAN, kein Schutz gegen einen gezielten Angriff.

Geändert am Prototyp (klein, ohne laufende App ohne Wirkung): `index.html` lädt `app-kamera.js`; `main.js`
nimmt von App-Kameras Aufnahmezeit und Kameradaten und skaliert die Stereo-Kalibrierung auf den gemessenen
Kameraabstand; `splat/process_capture.py` gibt die Körpergrösse aus der Metadatei an die Pipeline weiter.

### Nachtrag 20.11.2026: erster Test am iPhone 15 Pro

Aufnahme `scan-1033` mit Ultraweitwinkel, 3024×4032, 122 s: kein Bild verworfen, Kameradaten pro Bild vom
Gerät, HDR, Stabilisierung und Center Stage aus, Körperdrehung 356° gezählt, Datei vollständig übertragen.
Damit am Gerät bestätigt: H-1, H-4, H-5, H-8, H-9, H-10, H-16, H-17, M-1, T-3, T-4.

Dabei gefunden und behoben:

- Weissabgleich wurde direkt nach dem Kamerastart gesperrt, bevor er sich eingependelt hatte (starker
  Blaustich). Die Kamera pendelt sich jetzt erst ein; beim Sperren merkt sich der Mac die genauen Werte.
- «Fester Wert» übernahm die lange Verschlusszeit der Automatik (1/30 s). Beim Sperren wird jetzt auf
  höchstens 1/100 s gekürzt und die ISO entsprechend erhöht.
- Neu: Schritt «Einrichten und sperren» in der Aufnahme-Ansicht, wenn die Kamera an ihrem Platz steht.
- Neu: Ansage wahlweise vom Mac, vom Handy oder von beiden, mit Testknopf (vorher sprach nur das Handy,
  wenn es Kamera A war).

Am Gerät noch offen: die Korrekturen selbst, ob das Handy überhaupt spricht (H-13), und ob die Meldung
«bewegt» (H-18) zu empfindlich ist; sie schlug während der Aufnahme an.

Für die Pipeline: Weisses T-Shirt vor weisser Wand reisst mit `--mask auto` Löcher in den Oberkörper,
mit `--mask person` sind die Masken fast sauber. Mit Ultraweitwinkel füllt die Person nur 4–5 % des Bildes.

### Nachtrag 20.11.2026, zweite Aufnahme `scan-1101`

Splat gerechnet: 120 von 120 Bildern registriert, Kamerabahn 339°, 15 von 15 Gelenken. Der Körper ist
vollständig, aber grob (rund 3900 Kleckse), weil die Person mit Ultraweitwinkel nur 3 % des Bildes füllt.
Blaustich behoben. **Entscheid:** Hauptkamera 1× mit 4K für den Scan, Ultraweitwinkel fürs Tracking;
dafür gibt es in der Mac-App je einen Knopf («Für Scan einstellen», «Für Tracking einstellen»).

Neu im Ablauf: Phase «frei bewegen» nach der Körperdrehung (Zeitmarken `motionStart`, `motionEnd`, von der
Pipeline noch nicht ausgewertet) und ein Gesichtsmodell, das im Gesichtsscan die Kopfdrehung misst.

Offen für die Pipeline: Im Gesichtsscan dreht man den Kopf natürlicherweise nur nach links und rechts.
Dafür findet COLMAP keine Kamerabahn (3°), und am Hinterkopf des aufgesetzten Kopfs bleiben Störkleckse.

### Nachtrag 20.11.2026, dritte Aufnahme `scan-1209` (Hauptkamera, 4K)

Das automatische Einstellen beim Start hat am Handy funktioniert: Hauptkamera, 3840×2160 hochkant, ISO 247,
1/100 s, 4900 K. Die Körperdrehung wurde aber nach 36 s bei 177° abgebrochen, weil langsamer gedreht wurde
als die Richtzeit. Behoben: abgebrochen wird nur noch, wenn es 15 s nicht mehr vorwärts geht.

**Entscheid:** Körper und Gesicht sind getrennte Aufnahmen (Umschalter «Körper | Gesicht» in der
Aufnahme-Ansicht). Der Gesichtsscan ist kein Rundum-Drehen mehr: man sitzt nah an der Kamera und dreht den
Kopf geführt zur einen Seite, zur anderen und zurück; das Gesichtsmodell misst mit (am Gesichtsteil von
`scan-1101` geprüft: 122° in 14 s). Die Metadatei eines Gesichtsscans hat nur `faceStart`/`faceEnd` und
im Feld `body` den Namen der Körper-Aufnahme; `process_capture.py` rechnet dann nur den Kopf-Splat und
setzt ihn auf diesen Körper.

Offen für die Pipeline: Bei gedrehtem Kopf und ruhigem Oberkörper findet COLMAP keine Kamerabahn, weil die
Maske Kopf und Schultern als einen starren Körper behandelt. Nötig wären eine Maske nur für den Kopf und
ein Zusammensetzen, das vom Kopf-Scan nur die Vorderseite übernimmt.
