// Haende der Koerperseite zuordnen: ueber den Abstand zum Handgelenk der Koerperpose
// (robuster als das Links/Rechts-Label des Handmodells).
import { LM, type Landmark, type Landmark2D, toThree } from './landmarks';
import type { Vec3 } from './vec';

export const SIDES = ['Left', 'Right'] as const;
export type Side = (typeof SIDES)[number];
export type Hands<T> = Record<Side, T | null>;

/** Ergebnis des Handmodells: je Hand 21 Bildpunkte und 21 Weltpunkte. */
export interface HandDetection {
  landmarks: Landmark2D[][];
  worldLandmarks: Landmark[][];
}

const MAX_DISTANCE = 0.15; // Abstand Handgelenk (Hand) zu Handgelenk (Koerper) im Bild

export function assignHands(hands: HandDetection | null, img: Landmark2D[] | null): Hands<Vec3[]> {
  const out: Hands<Vec3[]> = { Left: null, Right: null };
  if (!hands || !img) return out;
  const wrists: Record<Side, Landmark2D> = { Left: img[LM.lWr], Right: img[LM.rWr] };
  const candidates: { h: number; side: Side; d: number }[] = [];
  hands.landmarks.forEach((lms, h) => {
    for (const side of SIDES) {
      const d = Math.hypot(lms[0].x - wrists[side].x, lms[0].y - wrists[side].y);
      candidates.push({ h, side, d });
    }
  });
  candidates.sort((a, b) => a.d - b.d);
  const used = new Set<number>();
  for (const { h, side, d } of candidates) {
    if (out[side] || used.has(h) || d > MAX_DISTANCE) continue;
    out[side] = hands.worldLandmarks[h].map(toThree);
    used.add(h);
  }
  return out;
}
