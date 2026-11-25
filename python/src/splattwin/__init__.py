"""Splattwin: Person als Gaussian Splat aufnehmen und live per Kamera-Tracking bewegen.

Pakete:
  io         Dateiformate (COLMAP, PLY)
  geometry   Mehrbild-Geometrie (Triangulation, Umeyama, Quaternionen)
  vision     Koerpererkennung (MediaPipe) und Freistellen (rembg, Hintergrundbild)
  pipeline   Video -> Splat, Kopf aufsetzen, Gelenke, ganze Aufnahme rechnen
  server     lokaler Server: Seiten, Kalibrierung, Aufnahmen, Live-Weiterleitung

Abhaengigkeiten laufen nur in eine Richtung: pipeline und server duerfen io, geometry und vision
benutzen, nie umgekehrt. Die Schritte der Pipeline importieren sich nicht gegenseitig.
"""
