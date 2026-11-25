// Was ueber die beiden Kameras A und B bekannt ist: Kameradaten (Schachbrett oder App) oder,
// solange keine da sind, der eingegebene Oeffnungswinkel.
import type { Intrinsics } from '../contracts';
import type { Landmark2D } from '../core/landmarks';
import type { CameraModel } from '../core/measure';
import { focalFromFov, normalizePoint, undistort } from '../core/stereo';
import { loadJson, removeKey, saveJson } from '../ui/storage';

export type CamId = 'A' | 'B';
export const CAMS: CamId[] = ['A', 'B'];

const KEY = 'cvai-intrinsics';

export class CameraSetup {
  readonly intrinsics: Record<CamId, Intrinsics | null> = { A: null, B: null };
  /** vertikaler Oeffnungswinkel in Grad, falls keine Kameradaten da sind */
  readonly fov: Record<CamId, number> = { A: 50, B: 40 };

  constructor(private readonly videos: Record<CamId, HTMLVideoElement>) {
    const saved = loadJson<Partial<Record<CamId, Intrinsics>>>(KEY);
    for (const cam of CAMS) if (saved?.[cam]?.dist?.length === 5) this.intrinsics[cam] = saved[cam];
  }

  set(cam: CamId, k: Intrinsics | null): void {
    this.intrinsics[cam] = k;
    saveJson(KEY, this.intrinsics);
  }

  clear(): void {
    this.intrinsics.A = this.intrinsics.B = null;
    removeKey(KEY);
  }

  /** Brennweite in Bildhoehen: gemessen, falls kalibriert, sonst aus dem Oeffnungswinkel. */
  focal(cam: CamId): number {
    return this.intrinsics[cam]?.fy ?? focalFromFov(this.fov[cam] || 50);
  }

  aspect(cam: CamId): number {
    const v = this.videos[cam];
    return v.videoWidth / v.videoHeight;
  }

  /** MediaPipe-Bildpunkt (0..1) -> normierte, entzerrte Bildkoordinaten. */
  normalize(cam: CamId, p: Landmark2D): [number, number] {
    const k = this.intrinsics[cam];
    if (!k) return normalizePoint(p, this.aspect(cam), this.focal(cam));
    return undistort((p.x - k.cx) / k.fx, (p.y - k.cy) / k.fy, k.dist);
  }

  model(cam: CamId): CameraModel {
    return { aspect: this.aspect(cam), focal: this.focal(cam), normalize: (p) => this.normalize(cam, p) };
  }
}
