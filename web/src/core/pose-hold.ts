// Einfrieren statt Springen: Verliert die Erkennung ein Gelenk (aus dem Bild, verdeckt, zu unsicher),
// bleibt es an seiner letzten Stelle relativ zu seinem Elternglied und zum Rumpf. Dreht sich der
// Koerper, dreht das eingefrorene Glied mit; bewegt sich der Ellbogen, kommt die eingefrorene Hand mit.
// Erst nach `maxHoldS` ohne Messung gilt das Gelenk als verloren (null), dann uebernimmt die
// Ruhehaltung des Avatars. Kommt es wieder, gilt sofort die Messung; den Uebergang glaettet der
// Bewegungsbegrenzer im Avatar.
import { LM } from './landmarks';
import { add, cross, type Mat3, mulMtV, mulMV, norm, scale, sub, type Vec3 } from './vec';

const POSE_COUNT = 33;
const CENTER = -1;

/** Elternglied je MediaPipe-Gelenk; CENTER = Mitte des Rumpfs. Eltern stehen vor ihren Kindern. */
const PARENT: number[] = (() => {
  const p = new Array<number>(POSE_COUNT).fill(CENTER);
  // Arme und Haende
  p[LM.lEl] = LM.lSh;
  p[LM.rEl] = LM.rSh;
  p[LM.lWr] = LM.lEl;
  p[LM.rWr] = LM.rEl;
  for (const i of [17, 19, 21]) p[i] = LM.lWr;
  for (const i of [18, 20, 22]) p[i] = LM.rWr;
  // Beine und Fuesse
  p[LM.lKn] = LM.lHip;
  p[LM.rKn] = LM.rHip;
  p[LM.lAn] = LM.lKn;
  p[LM.rAn] = LM.rKn;
  p[29] = LM.lAn;
  p[31] = LM.lAn;
  p[30] = LM.rAn;
  p[32] = LM.rAn;
  return p;
})();
const TORSO = [LM.lSh, LM.rSh, LM.lHip, LM.rHip];
/** Reihenfolge: zuerst Rumpf und Kopf, dann die Glieder von innen nach aussen. */
const ORDER = (() => {
  const depth = (i: number): number => (PARENT[i] === CENTER ? 0 : 1 + depth(PARENT[i]!));
  return Array.from({ length: POSE_COUNT }, (_, i) => i).sort((a, b) => depth(a) - depth(b));
})();

/** Ausrichtung des Rumpfs als Drehmatrix (Spalten: links, oben, vorne), oder null. */
export function torsoBasis(P: (Vec3 | null)[]): Mat3 | null {
  const [ls, rs, lh, rh] = TORSO.map((i) => P[i] ?? null);
  const left = ls && rs ? sub(ls, rs) : lh && rh ? sub(lh, rh) : null;
  const top = ls && rs ? scale(add(ls, rs), 0.5) : null;
  const bottom = lh && rh ? scale(add(lh, rh), 0.5) : null;
  if (!left || !top || !bottom) return null;
  const x = unit(left);
  if (!x) return null;
  const f = cross(x, sub(top, bottom));
  if (norm(f) < 1e-6) return null;
  const z = unit(f)!;
  const y = cross(z, x);
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}

function unit(v: Vec3): Vec3 | null {
  const n = norm(v);
  return n < 1e-9 ? null : scale(v, 1 / n);
}

function center(P: (Vec3 | null)[]): Vec3 | null {
  const pts = TORSO.map((i) => P[i]).filter((p): p is Vec3 => !!p);
  if (!pts.length) return null;
  return scale(pts.reduce((s, p) => add(s, p), [0, 0, 0] as Vec3), 1 / pts.length);
}

export class PoseHold {
  /** Versatz zum Elternglied im Rumpf-Koordinatensystem, beim letzten Sehen. */
  private readonly offset: (Vec3 | null)[] = new Array(POSE_COUNT).fill(null);
  private readonly lost: number[] = new Array(POSE_COUNT).fill(0);
  private basis: Mat3 | null = null;
  private lastCenter: Vec3 | null = null;
  private hands: Record<'Left' | 'Right', { pts: Vec3[]; lost: number } | null> = { Left: null, Right: null };

  constructor(readonly maxHoldS = 4) {}

  reset(): void {
    this.offset.fill(null);
    this.lost.fill(0);
    this.basis = null;
    this.lastCenter = null;
    this.hands = { Left: null, Right: null };
  }

  /** Fuellt fehlende Gelenke mit der eingefrorenen Haltung. dt in Sekunden. */
  step(points: (Vec3 | null)[] | null, dt: number): (Vec3 | null)[] | null {
    const P = points ?? new Array<Vec3 | null>(POSE_COUNT).fill(null);
    // Rumpf: aktuelle Ausrichtung, sonst die zuletzt bekannte.
    const R = torsoBasis(P) ?? this.basis;
    const out: (Vec3 | null)[] = new Array(POSE_COUNT).fill(null);
    let c = center(P);
    for (const i of ORDER) {
      const parent = PARENT[i]!;
      const ref = parent === CENTER ? c : out[parent];
      const z = P[i] ?? null;
      if (z) {
        this.lost[i] = 0;
        out[i] = z;
        this.offset[i] = ref && R ? mulMtV(R, sub(z, ref)) : null;
        continue;
      }
      this.lost[i]! += dt;
      const off = this.offset[i];
      // Rumpf ganz verloren: Rumpfgelenke an der letzten Stelle.
      const base = ref ?? (parent === CENTER ? this.lastCenter : null);
      if (off && base && R && this.lost[i]! <= this.maxHoldS) out[i] = add(base, mulMV(R, off));
    }
    if (R) this.basis = R;
    c = center(out);
    if (c) this.lastCenter = c;
    if (!points && out.every((p) => !p)) return null;
    return out;
  }

  /**
   * Haende (je 21 Punkte): fehlt eine, bleibt die letzte Handhaltung, verschoben auf das aktuelle
   * Handgelenk des Koerpers. wrist: Handgelenk aus step().
   */
  stepHand(side: 'Left' | 'Right', hand: Vec3[] | null, wrist: Vec3 | null, dt: number): Vec3[] | null {
    if (hand) {
      this.hands[side] = { pts: hand, lost: 0 };
      return hand;
    }
    const held = this.hands[side];
    if (!held || !wrist) return null;
    held.lost += dt;
    if (held.lost > this.maxHoldS) {
      this.hands[side] = null;
      return null;
    }
    const shift = sub(wrist, held.pts[0]!);
    return held.pts.map((p) => add(p, shift));
  }
}
