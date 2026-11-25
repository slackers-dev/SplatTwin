// Hilfen fuer Tests: Zufall mit festem Startwert und eine einfache Lochkamera.
import type { Landmark } from './landmarks';
import { add, type Mat3, mulMV, type Vec2, type Vec3 } from './vec';

/** Zufallszahlen mit festem Startwert (mulberry32), damit Tests reproduzierbar sind. */
export function random(seed = 1): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Drehung um die y-Achse (Kamera schaut seitlich), als Mat3. */
export const yaw = (deg: number): Mat3 => {
  const a = (deg * Math.PI) / 180;
  return [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
};

/** Projektion eines Punktes in Kamerakoordinaten auf normierte Bildkoordinaten. */
export const project = (p: Vec3): Vec2 => [p[0] / p[2], p[1] / p[2]];

/** Punkt in Kamera A -> Kamera B mit x_B = R x_A + T. */
export const toB = (p: Vec3, R: Mat3, T: Vec3): Vec3 => add(mulMV(R, p), T);

/** Grobes Skelett: 33 Gelenke relativ zur Huefte, Achsen von MediaPipe (y unten), Meter. */
export function skeleton(): Vec3[] {
  const pts: Vec3[] = Array.from({ length: 33 }, (_, i) => [0.02 * Math.sin(i), -0.5 + 0.01 * i, 0.03 * Math.cos(i)]);
  const set = (i: number, p: Vec3) => (pts[i] = p);
  set(0, [0, -0.65, -0.08]); // Nase
  set(7, [0.07, -0.66, 0]); set(8, [-0.07, -0.66, 0]);
  set(11, [0.19, -0.45, 0]); set(12, [-0.19, -0.45, 0]);
  set(13, [0.3, -0.22, 0.02]); set(14, [-0.3, -0.22, -0.02]);
  set(15, [0.36, 0.02, -0.05]); set(16, [-0.36, 0.02, 0.05]);
  set(23, [0.1, 0, 0]); set(24, [-0.1, 0, 0]);
  set(25, [0.11, 0.42, 0.03]); set(26, [-0.11, 0.42, -0.03]);
  set(27, [0.12, 0.82, 0]); set(28, [-0.12, 0.82, 0]);
  return pts;
}

export const landmark = (p: Vec3 | Vec2, visibility = 1): Landmark => ({ x: p[0], y: p[1], z: p[2] ?? 0, visibility });
