"""Pipeline: Video einer sich drehenden Person -> Gaussian Splat, ausgerichtet und mit Gelenken.

frames    scharfe Einzelbilder aus dem Video waehlen
(vision.segmentation)  Person freistellen
dataset   Bilder und Masken fuer COLMAP und Brush ablegen
sfm       COLMAP: Kameraposen nur auf der Person
train     Brush trainiert den Splat
align     Splat aufrichten und auf Koerpergroesse bringen (splat.json)
rig       Gelenke im Splat (rig.json)
merge_head  Kopf-Splat aus der Nahaufnahme aufsetzen
splat     Schritte frames bis align fuer ein oder zwei Videos
process   ganze Aufnahme aus capture.json
"""
