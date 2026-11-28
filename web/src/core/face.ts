// Kopf und Mund aus dem Gesichtsmodell von MediaPipe (Face Landmarker).
//
// Das Gesichtsmodell liefert pro Bild eine 4x4-Matrix vom Standardgesicht in die Kamera und Werte fuer
// Gesichtsausdruecke (Blendshapes, darunter jawOpen = Mund offen, 0..1). Seine Kamera hat dieselben
// Achsen wie der Avatar (x = links der Person, y oben, z zum Betrachter); mit dem eigenen Video geprueft:
// Die Drehrichtung stimmt mit der aus Nase und Ohren ueberein, nur genauer. Die Drehung der Matrix ist
// also direkt die Haltung des Kopfes; Blick in die Kamera = keine Drehung.
import type { Landmark2D } from './landmarks';

export type Quat = [number, number, number, number];

/** Kopf fuer den Avatar: Drehung (x, y, z, w) und Mund offen (0..1). */
export interface FacePose {
  q: Quat;
  jaw: number;
}

/** Drehung aus einer 4x4-Matrix (spaltenweise wie bei MediaPipe), Skalierung herausgerechnet. */
export function quatFromMatrix(m: ArrayLike<number>): Quat {
  // Spalten normieren: die Matrix enthaelt die Groesse des Gesichts.
  const col = (c: number) => {
    const v = [m[c * 4]!, m[c * 4 + 1]!, m[c * 4 + 2]!];
    const n = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
    return v.map((x) => x / n);
  };
  const [x, y, z] = [col(0), col(1), col(2)];
  // r(i, j): Zeile i, Spalte j
  const r = (i: number, j: number) => [x, y, z][j]![i]!;
  const tr = r(0, 0) + r(1, 1) + r(2, 2);
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(r(2, 1) - r(1, 2)) / s, (r(0, 2) - r(2, 0)) / s, (r(1, 0) - r(0, 1)) / s, s / 4];
  } else if (r(0, 0) > r(1, 1) && r(0, 0) > r(2, 2)) {
    const s = Math.sqrt(1 + r(0, 0) - r(1, 1) - r(2, 2)) * 2;
    q = [s / 4, (r(0, 1) + r(1, 0)) / s, (r(0, 2) + r(2, 0)) / s, (r(2, 1) - r(1, 2)) / s];
  } else if (r(1, 1) > r(2, 2)) {
    const s = Math.sqrt(1 + r(1, 1) - r(0, 0) - r(2, 2)) * 2;
    q = [(r(0, 1) + r(1, 0)) / s, s / 4, (r(1, 2) + r(2, 1)) / s, (r(0, 2) - r(2, 0)) / s];
  } else {
    const s = Math.sqrt(1 + r(2, 2) - r(0, 0) - r(1, 1)) * 2;
    q = [(r(0, 2) + r(2, 0)) / s, (r(1, 2) + r(2, 1)) / s, s / 4, (r(1, 0) - r(0, 1)) / s];
  }
  return normalize(q);
}

function normalize(q: Quat): Quat {
  const n = Math.hypot(...q) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Zwischen zwei Drehungen (k = 0: a, 1: b), auf dem kuerzeren Weg. */
export function mixQuat(a: Quat, b: Quat, k: number): Quat {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = dot < 0 ? -1 : 1;
  return normalize([a[0] + (s * b[0] - a[0]) * k, a[1] + (s * b[1] - a[1]) * k, a[2] + (s * b[2] - a[2]) * k, a[3] + (s * b[3] - a[3]) * k]);
}

export function mixFace(a: FacePose | null, b: FacePose | null, k: number): FacePose | null {
  if (!a || !b) return b;
  return { q: mixQuat(a.q, b.q, k), jaw: a.jaw + (b.jaw - a.jaw) * k };
}

/**
 * Ausschnitt um den Kopf (Bildpunkte, quadratisch) aus den Koerperpunkten: Mitte aus Nase und Ohren,
 * Groesse etwas mehr als die Schulterbreite. Im ganzen Bild ist das Gesicht ab etwa 2 m zu klein fuer
 * das Gesichtsmodell; vergroessert findet es das Gesicht wieder. null, wenn der Kopf nicht sicher im Bild ist.
 */
export function headCrop(img: (Landmark2D & { visibility?: number })[], width: number, height: number): { x: number; y: number; size: number } | null {
  const head = [img[0], img[7], img[8]];
  if (head.some((p) => !p || (p.visibility ?? 1) < 0.5)) return null;
  const cx = ((head[0]!.x + head[1]!.x + head[2]!.x) / 3) * width;
  const cy = ((head[0]!.y + head[1]!.y + head[2]!.y) / 3) * height;
  const l = img[11],
    r = img[12];
  const ears = Math.hypot((head[1]!.x - head[2]!.x) * width, (head[1]!.y - head[2]!.y) * height);
  const shoulders = l && r ? Math.hypot((l.x - r.x) * width, (l.y - r.y) * height) : 0;
  const size = Math.max(48, 1.1 * shoulders, 2.6 * ears);
  if (cx < 0 || cy < 0 || cx > width || cy > height) return null;
  return { x: cx - size / 2, y: cy - size / 2, size };
}
