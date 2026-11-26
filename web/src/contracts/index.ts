// Datenformate zwischen den Teilen des Projekts. Die Typen werden aus contracts/*.schema.json erzeugt
// (npm run gen:contracts), siehe contracts/README.md.
import type { Vec3 } from './generated';

export type { Capture, Hand, Intrinsics, LiveFrame, RunRig, RunSmplx, RunSplat, SavedVideo, StageMeta, StageSlides, Vec3 } from './generated';

/** Ein Gelenk im Live-Frame: Position in Metern oder null, wenn unbekannt. */
export type Point = Vec3 | null;
