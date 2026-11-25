"""Lokaler Server: liefert die Seiten (web/dist) und die Laeufe (data/runs) aus, kalibriert Kameras
mit OpenCV, speichert Aufnahmen aus dem Browser und leitet das Live-Tracking an Zuschauer weiter.

  calibration  Schachbrett: Ecken suchen, calibrateCamera (3DRecon 1)
  captures     Aufnahme aus dem Browser speichern und nach MP4 mit festen 30 fps umwandeln
  live         letztes Bild des Trackers an alle Zuschauer (Server-Sent Events)
  network      Adressen im lokalen Netz
  app          FastAPI: Routen, Zugriffsschutz, statische Dateien; API-Doku unter /api/docs
"""
