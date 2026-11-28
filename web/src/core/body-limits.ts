// Was ein Koerper nicht kann, kommt auch nicht im Avatar an:
// - Haende und Ellbogen dringen nicht in Rumpf und Kopf ein. Liegt ein gemessener Punkt darin
//   (Hand auf dem Bauch, Hand am Kopf, Rauschen), wird er an die Oberflaeche geschoben. So bleibt
//   die Hand am Koerper liegen, statt hineinzugleiten.
// - Knie knicken nicht nach vorne durch (hoechstens ein paar Grad Ueberstreckung).
// Rumpf als elliptischer Zylinder zwischen Huefte und Schultern, Kopf als Kugel um die Ohren.
// Masse aus den gemessenen Gelenken der Person, nicht fest.
import { LM } from './landmarks';
import { torsoBasis } from './pose-hold';
import { add, cross, dot, type Mat3, mulMtV, mulMV, norm, scale, sub, type Vec3 } from './vec';

/** Halbachsen des Rumpfs als Anteil der Schulterbreite (Abstand der Schultergelenke). */
const TORSO_HALF_WIDTH = 0.4;
const TORSO_HALF_DEPTH = 0.33;
/** Kopfradius als Anteil des Ohrabstands, plus Haare. */
const HEAD_RADIUS = 0.5;
const HEAD_EXTRA = 0.02; // m
/** Dicke der Hand bzw. des Arms: so weit bleibt der Punkt von der Oberflaeche weg. */
const MARGIN = 0.03; // m
const KNEE_HYPEREXTENSION = (8 * Math.PI) / 180;

const ARM: { joint: number; children: number[] }[] = [
  { joint: LM.lWr, children: [17, 19, 21] },
  { joint: LM.rWr, children: [18, 20, 22] },
  { joint: LM.lEl, children: [] },
  { joint: LM.rEl, children: [] },
];
const LEGS = [
  { hip: LM.lHip, knee: LM.lKn, ankle: LM.lAn, children: [29, 31] },
  { hip: LM.rHip, knee: LM.rKn, ankle: LM.rAn, children: [30, 32] },
];

export interface LimitReport {
  /** Punkte, die aus Rumpf oder Kopf geschoben wurden */
  pushed: number;
  /** Knie, deren Ueberstreckung begrenzt wurde */
  knees: number;
}

/** Verschiebt Punkt i und seine Kinder um d. */
function move(P: (Vec3 | null)[], i: number, children: number[], d: Vec3): void {
  P[i] = add(P[i]!, d);
  for (const c of children) if (P[c]) P[c] = add(P[c]!, d);
}

/** Wendet die Grenzen an. Gibt eine neue Liste zurueck; P bleibt unveraendert. */
export function limitBody(points: (Vec3 | null)[] | null, report?: LimitReport): (Vec3 | null)[] | null {
  if (!points) return null;
  const P = points.slice();
  const R = torsoBasis(P);
  if (!R) return P;
  const lSh = P[LM.lSh]!,
    rSh = P[LM.rSh]!,
    lHip = P[LM.lHip]!,
    rHip = P[LM.rHip]!;
  const width = norm(sub(lSh, rSh));
  const bottom = scale(add(lHip, rHip), 0.5);
  const top = scale(add(lSh, rSh), 0.5);
  const height = dot(sub(top, bottom), [R[1], R[4], R[7]]);

  for (const { joint, children } of ARM) {
    const p = P[joint];
    if (!p) continue;
    const d = pushOutOfTorso(R, bottom, height, width, p) ?? pushOutOfHead(P, p);
    if (d) {
      move(P, joint, children, d);
      if (report) report.pushed++;
    }
  }

  const left: Vec3 = [R[0], R[3], R[6]];
  for (const leg of LEGS) {
    const H = P[leg.hip],
      K = P[leg.knee],
      A = P[leg.ankle];
    if (!H || !K || !A) continue;
    const A2 = limitKnee(H, K, A, left);
    if (A2) {
      move(P, leg.ankle, leg.children, sub(A2, A));
      if (report) report.knees++;
    }
  }
  return P;
}

/** Verschiebung, die p aus dem Rumpf holt, oder null. */
function pushOutOfTorso(R: Mat3, bottom: Vec3, height: number, width: number, p: Vec3): Vec3 | null {
  const local = mulMtV(R, sub(p, bottom)); // x links, y oben, z vorne
  if (local[1] < -0.05 || local[1] > height) return null;
  const a = TORSO_HALF_WIDTH * width + MARGIN,
    b = TORSO_HALF_DEPTH * width + MARGIN;
  const r = Math.hypot(local[0] / a, local[2] / b);
  if (r >= 1) return null;
  // Mitten im Rumpf (Richtung unklar): nach vorne.
  const [x, z] = r < 1e-6 ? [0, b] : [local[0] / r, local[2] / r];
  return mulMV(R, [x - local[0], 0, z - local[2]]);
}

/** Verschiebung, die p aus dem Kopf holt, oder null. */
function pushOutOfHead(P: (Vec3 | null)[], p: Vec3): Vec3 | null {
  const lEar = P[LM.lEar],
    rEar = P[LM.rEar];
  if (!lEar || !rEar) return null;
  const c = scale(add(lEar, rEar), 0.5);
  const radius = HEAD_RADIUS * norm(sub(lEar, rEar)) + HEAD_EXTRA + MARGIN;
  const v = sub(p, c);
  const n = norm(v);
  if (n >= radius) return null;
  const dir: Vec3 = n < 1e-6 ? [0, 0, 1] : scale(v, 1 / n);
  return scale(dir, radius - n);
}

/**
 * Neuer Knoechel, wenn das Knie nach vorne durchknickt, sonst null. left: Links-Achse des Rumpfs,
 * ungefaehr die Scharnierachse beider Knie. Beugen dreht den Unterschenkel positiv um diese Achse.
 */
export function limitKnee(H: Vec3, K: Vec3, A: Vec3, left: Vec3): Vec3 | null {
  const t = sub(K, H),
    s = sub(A, K);
  const tl = norm(t),
    sl = norm(s);
  if (tl < 1e-6 || sl < 1e-6) return null;
  const tu = scale(t, 1 / tl);
  const perp = sub(s, scale(tu, dot(s, tu)));
  const angle = Math.atan2(norm(perp), dot(s, tu));
  if (angle <= KNEE_HYPEREXTENSION) return null;
  const axis = cross(tu, scale(s, 1 / sl));
  // Nur wenn die Beugung klar in die falsche Richtung geht (bei stark gedrehtem Bein ist die Achse unsicher).
  if (dot(axis, left) / norm(axis) > -0.5) return null;
  const pu = scale(perp, 1 / norm(perp));
  const dir = add(scale(tu, Math.cos(KNEE_HYPEREXTENSION)), scale(pu, Math.sin(KNEE_HYPEREXTENSION)));
  return add(K, scale(dir, sl));
}
