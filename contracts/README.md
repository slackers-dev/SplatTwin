# Verträge

Die Datenformate zwischen den Teilen des Projekts, als JSON-Schema. **Hier ist die einzige Quelle der
Wahrheit:**

- TypeScript-Typen werden daraus erzeugt (`npm run gen:contracts` in `web/`, Ergebnis in
  `web/src/contracts/generated.ts`). Sie werden nicht von Hand geändert.
- Python prüft Dateien an den Grenzen dagegen (`splattwin.contracts.validate`).
- Jedes Schema hat ein Beispiel in `examples/`. Beide Testsuiten prüfen die Beispiele.

| Schema | Wo | Schreibt | Liest |
|---|---|---|---|
| `capture.schema.json` | `data/captures/<name>.json` | `capture.html`, Mac-App | `splattwin process` |
| `run-splat.schema.json` | `data/runs/<lauf>/splat.json` | Pipeline (Ausrichtung) | Viewer, Avatar, Rig |
| `run-rig.schema.json` | `data/runs/<lauf>/rig.json` | Pipeline (Rig) | Splat-Avatar |
| `run-smplx.schema.json` | `data/runs/<lauf>/smplx.json` (+ `smplx_skin.bin`) | `scripts/pod-do/lhm_zum_viewer.py` | Splat-Avatar |
| `intrinsics.schema.json` | `POST /api/calibrate`, App-Kameras | Server, App-Brücke | Tracking |
| `live-frame.schema.json` | `/ws/send`, `/ws/stage`, binär (`web/src/live/protocol.ts`) | Tracking-Seite | Bühne, Regie |
| `stage-meta.schema.json` | `/ws/send`, `/ws/stage`, `data/stage/seats.json` | Tracking-Seite | Bühne, Regie |
| `stage-slides.schema.json` | `/ws/stage`, `data/stage/slides.json` | Server (nach Upload, Regie) | Bühne, Regie |

Die Schemas beschreiben die Formate so, wie sie heute geschrieben werden. Die Mac-App schreibt
`capture.json` selbst (`CaptureMeta` in `app/Kit/Sources/SplattwinKit/CaptureStore.swift`), dort müssen
Änderungen ebenfalls nachgezogen werden.

## Lauf-Ordner

```
data/runs/<lauf>/
  splat.ply          Gaussian Splat in COLMAP-Koordinaten (wie Brush ihn schreibt)
  splat.json         Ausrichtung COLMAP -> Welt                     (run-splat)
  rig.json           Gelenke der Person in Weltkoordinaten          (run-rig)
  smplx.json         SMPL-X-Skelett eines LHM-Avatars                (run-smplx)
  smplx_skin.bin     Gewichte jedes Klecks an den SMPL-X-Gelenken (Format in run-smplx)
  skin.bin           Splat schon aufs Skelett gelegt, von der Tracking-Seite vorgerechnet (web/src/avatar/skin-cache.ts)
  splat_koerper.ply  Körper-Splat vor dem Aufsetzen des Kopfs (nur nach merge-head)
  head.json          Bericht von merge-head (nicht Teil des Vertrags)
  masken_check.jpg, rig_check.jpg   Kontrollbilder
  frames/ masks/ data/ sparse_all/ colmap.db   Zwischenstände, dürfen gelöscht werden
```

## Regeln

- Ein Schema wird nur zusammen mit dem Beispiel, den erzeugten Typen und allen Lesern und Schreibern
  geändert (Web, Python, App).
- Koordinaten und Einheiten: siehe [`../docs/konventionen.md`](../docs/konventionen.md).
