// Rektifizierung (3DRecon 2-3) und Genauigkeit der Triangulation.
//
// Rektifizieren heisst: beide Kameras rechnerisch so drehen, dass sie parallel schauen und die
// Verbindungslinie der Kamerazentren (Basislinie) waagrecht im Bild liegt. Dann liegt jeder Punkt
// in beiden Bildern auf derselben Zeile, und die Tiefe folgt aus der Disparitaet: Z = b / d.
//
// Wichtig fuer dieses Projekt: Rektifizieren ist nur eine Drehung jeder Kamera um ihr Zentrum
// (Homographie H = K' R_rect K^-1). Es kommt keine Information dazu. Die Genauigkeit haengt nur
// vom Aufbau ab (Abstand der Kameras, Winkel der Sehstrahlen) und vom Fehler der Bildpunkte.
// Fuer einzelne Gelenke rechnen Triangulation und EKF schon mit beliebig gedrehten Kameras.
// Die Rektifizierung ist hier ein Messwerkzeug: Der Zeilenversatz gleicher Gelenke zeigt direkt,
// wie gut Kalibrierung und Gelenkerkennung zusammenpassen.
//
// Konventionen wie in stereo.ts: x_B = R x_A + T, Kamerakoordinaten x rechts, y unten, z vorne.
import { type StereoPose, triangulate } from './stereo';
import { cross, dot, type Mat3, mulMtV, mulMV, norm, scale, sub, type Vec2, type Vec3 } from './vec';

export interface Rectification {
  /** Drehung Kamera A -> rektifiziertes System (zeilenweise) */
  RA: Mat3;
  /** Drehung Kamera B -> rektifiziertes System */
  RB: Mat3;
  /** Basislinie in Metern, mit Vorzeichen: Kamera B sitzt im rektifizierten System bei (s * b, 0, 0) */
  baseline: number;
  /** Winkel zwischen den Blickrichtungen der Kameras (Grad) */
  vergence: number;
  /**
   * Kleinster Winkel zwischen Basislinie und einer Blickrichtung (Grad). Unter etwa 25 Grad liegt
   * der Epipol fast im Bild (eine Kamera steht hinter der anderen): das rektifizierte Bild wird
   * stark verzerrt.
   */
  conditioning: number;
}

const rows = (a: Vec3, b: Vec3, c: Vec3): Mat3 => [...a, ...b, ...c] as Mat3;
const unit = (v: Vec3): Vec3 => scale(v, 1 / norm(v));
const deg = (rad: number): number => (rad * 180) / Math.PI;
const angle = (a: Vec3, b: Vec3): number => deg(Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b))))));

/** Transponierte 3x3-Matrix. */
const transposeM = (M: Mat3): Mat3 => [M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]];

/** Produkt A * B^T fuer 3x3. */
function mulMMt(A: Mat3, B: Mat3): Mat3 {
  const C = new Array(9) as Mat3;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c * 3] + A[r * 3 + 1] * B[c * 3 + 1] + A[r * 3 + 2] * B[c * 3 + 2];
  }
  return C;
}

/**
 * Rektifizierende Drehungen nach Fusiello (2000), Achsen wie bei Bouguet:
 * - neue x-Achse entlang der Basislinie (so gerichtet, dass sie ungefaehr nach rechts zeigt,
 *   sonst stuende das Bild kopf),
 * - neue z-Achse moeglichst nahe an der mittleren Blickrichtung beider Kameras,
 * - y = z x x (nach unten).
 * Beide Kameras werden so etwa um die Haelfte des Winkels zwischen ihnen gedreht.
 */
export function rectify({ R, T }: StereoPose): Rectification {
  const cB = scale(mulMtV(R, T), -1); // Zentrum von Kamera B in Koordinaten von A
  const b = norm(cB);
  if (b < 1e-9) throw new Error('Die Kameras stehen am selben Ort.');
  const zA: Vec3 = [0, 0, 1];
  const zB = mulMtV(R, [0, 0, 1]); // Blickrichtung von B in Koordinaten von A
  let ex = unit(cB);
  let sign = 1;
  if (ex[0] < 0) {
    ex = scale(ex, -1);
    sign = -1;
  }
  let zMean = unit([zA[0] + zB[0], zA[1] + zB[1], zA[2] + zB[2]]);
  // Schauen die Kameras fast gegeneinander, ist der Mittelwert unbestimmt: dann zA nehmen.
  if (!Number.isFinite(zMean[0])) zMean = zA;
  const ey = unit(cross(zMean, ex));
  const ez = cross(ex, ey);
  const RA = rows(ex, ey, ez); // A -> rektifiziert
  const RB = mulMMt(RA, R); // B -> A ist R^T, also B -> rektifiziert = RA R^T
  return {
    RA,
    RB,
    baseline: sign * b,
    vergence: angle(zA, zB),
    conditioning: Math.min(angle(cB, zA), angle(scale(cB, -1), zA), angle(cB, zB), angle(scale(cB, -1), zB)),
  };
}

/** Normierter Bildpunkt einer Kamera -> normierter Punkt im rektifizierten Bild. null = hinter der Kamera. */
export function rectifyPoint(n: Vec2, Rrect: Mat3): Vec2 | null {
  const r = mulMV(Rrect, [n[0], n[1], 1]);
  if (r[2] <= 1e-9) return null;
  return [r[0] / r[2], r[1] / r[2]];
}

/** Umkehrung: rektifizierter Punkt -> normierter Bildpunkt der Kamera (fuer das Umrechnen der Bilder). */
export function unrectifyPoint(r: Vec2, Rrect: Mat3): Vec2 | null {
  const n = mulMV(transposeM(Rrect), [r[0], r[1], 1]);
  if (n[2] <= 1e-9) return null;
  return [n[0] / n[2], n[1] / n[2]];
}

/** Tiefe im rektifizierten System aus der Disparitaet d = uA - uB:  Z = b / d. */
export function depthFromDisparity(uA: number, uB: number, baseline: number): number | null {
  const d = uA - uB;
  if (Math.abs(d) < 1e-9) return null;
  const Z = baseline / d;
  return Z > 0 ? Z : null;
}

/**
 * Lehrbuchformel fuer parallele Kameras: Ein Fehler der Disparitaet um sigmaD wirkt auf die
 * Tiefe wie  sigmaZ = Z^2 / (f b) * sigmaD. Doppelte Distanz = vierfacher Fehler,
 * doppelter Kameraabstand = halber Fehler. Alle Groessen in Metern bzw. normierten Koordinaten.
 */
export const depthSigmaParallel = (Z: number, baseline: number, sigmaD: number): number => (Z * Z * sigmaD) / Math.abs(baseline);

/** Umgekehrt: Welcher Kameraabstand reicht fuer die gewuenschte Tiefengenauigkeit? */
export const baselineFor = (Z: number, sigmaZ: number, sigmaD: number): number => (Z * Z * sigmaD) / sigmaZ;

export interface Precision {
  /** Standardabweichung entlang der Sichtlinie von der Mitte der Basislinie zum Punkt (m) */
  depth: number;
  /** Standardabweichung quer dazu, Mittel der beiden Querrichtungen (m) */
  lateral: number;
  /** schlechteste Richtung (m) */
  worst: number;
  /** Winkel zwischen den beiden Sehstrahlen am Punkt (Grad); je groesser, desto genauer die Tiefe */
  rayAngle: number;
}

/**
 * Wie genau wird Punkt X (Koordinaten von Kamera A) trianguliert, wenn jeder Bildpunkt um sigma
 * (normierte Koordinaten, also Pixel / Brennweite in Pixeln) streut? Fehlerfortpflanzung erster
 * Ordnung: Kovarianz = sigma^2 J J^T, J = Ableitung der Triangulation nach den vier Bildkoordinaten
 * (numerisch). Gilt fuer beliebig gedrehte Kameras, nicht nur fuer parallele.
 */
export function triangulationPrecision(X: Vec3, pose: StereoPose, sigmaA: number, sigmaB = sigmaA): Precision | null {
  const { R, T } = pose;
  const XB = add3(mulMV(R, X), T);
  if (X[2] <= 0 || XB[2] <= 0) return null;
  const n0 = [X[0] / X[2], X[1] / X[2], XB[0] / XB[2], XB[1] / XB[2]];
  const tri = (n: number[]) => triangulate([n[0], n[1]], [n[2], n[3]], R, T);
  const X0 = tri(n0);
  if (!X0) return null;
  const eps = 1e-6;
  const J: Vec3[] = []; // Spalten der Jacobi-Matrix
  for (let k = 0; k < 4; k++) {
    const n = [...n0];
    n[k] += eps;
    const Xk = tri(n);
    if (!Xk) return null;
    J.push(scale(sub(Xk, X0), 1 / eps));
  }
  const sig = [sigmaA, sigmaA, sigmaB, sigmaB];
  const C = new Array<number>(9).fill(0);
  for (let k = 0; k < 4; k++) {
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i * 3 + j] += sig[k] * sig[k] * J[k][i] * J[k][j];
  }
  const cB = scale(mulMtV(R, T), -1);
  const u = unit(sub(X, scale(cB, 0.5)));
  const varAlong = (v: Vec3) => dot(v, mulMV(C as Mat3, v));
  const depthVar = varAlong(u);
  const trace = C[0] + C[4] + C[8];
  return {
    depth: Math.sqrt(depthVar),
    lateral: Math.sqrt(Math.max(0, (trace - depthVar) / 2)),
    worst: Math.sqrt(largestEigen(C as Mat3)),
    rayAngle: angle(X, sub(X, cB)),
  };
}

const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** Groesster Eigenwert einer symmetrischen, positiv semidefiniten 3x3-Matrix (Potenzmethode). */
function largestEigen(C: Mat3): number {
  let v: Vec3 = [1, 1, 1];
  let lambda = 0;
  for (let it = 0; it < 100; it++) {
    const w = mulMV(C, v);
    const len = norm(w);
    if (len < 1e-30) return 0;
    lambda = len / norm(v);
    v = scale(w, 1 / len);
  }
  return lambda;
}
