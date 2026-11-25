// Von den Punkten der Koerpererkennung zur 3D-Messung, die der Filter bekommt.
//
// Eine Kamera:   3D-Pose direkt aus MediaPipe, Position im Raum aus dem Lochkamera-Modell.
// Zwei Kameras:  Gelenke, die beide sehen, werden trianguliert (gemessene Tiefe), die uebrigen
//                kommen aus der Einzelschaetzung und werden an die triangulierten Punkte gehaengt.
import type { JointObservation } from './ekf';
import { camToThree, LM, type Landmark, type Landmark2D, POSE_COUNT, toThree } from './landmarks';
import { type CalibrationFrame, type StereoPose, triangulate } from './stereo';
import { add, type Mat3, mulMtV, norm, scale, sub, type Vec2, type Vec3 } from './vec';

export const MIN_VISIBILITY = 0.5;
/** Gelenke fuer die Stereo-Kalibrierung: Kopf, Arme, Huefte, Beine. */
export const CALIB_JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

/** Was ueber eine Kamera bekannt ist. */
export interface CameraModel {
  /** Bildbreite / Bildhoehe */
  aspect: number;
  /** Brennweite in Bildhoehen */
  focal: number;
  /** MediaPipe-Bildpunkt (0..1) -> normierte, entzerrte Bildkoordinaten */
  normalize(p: Landmark2D): Vec2;
}

export interface Measurement {
  /** Gelenke relativ zur Huefte, Achsen des Avatars */
  pts: (Vec3 | null)[];
  /** Sichtbarkeit je Gelenk */
  vis: number[];
  /** Position der Huefte im Raum (x, 0, z), null wenn unbekannt */
  root: Vec3 | null;
  /** Anzahl triangulierter Gelenke (nur Stereo) */
  nTri: number;
  /** Stereo: Gelenke in Koordinaten von Kamera A, Startwerte fuer den EKF */
  abs?: (Vec3 | null)[];
}

export const inFrame = (p: Landmark2D): boolean => p.x > -0.02 && p.x < 1.02 && p.y > -0.02 && p.y < 1.02;

/** Gelenk i sicher gesehen? Gelenke ausserhalb des Bildes raet das Modell nur. */
export const okJoint = (world: Landmark[] | null, img: Landmark2D[] | null, i: number, min = MIN_VISIBILITY): boolean =>
  !!world && !!img && inFrame(img[i]) && (world[i].visibility ?? 1) >= min;

const asVec = (l: Landmark): Vec3 => [l.x, l.y, l.z];

/**
 * Position der Person vor der Kamera aus dem Lochkamera-Modell:
 * Tiefe Z = f * (reale Laenge) / (Laenge im Bild). Als Massstab dienen Rumpfstrecken,
 * deren reale Laenge parallel zur Bildebene aus den 3D-Landmarks bekannt ist.
 */
export function estimateRoot(img: Landmark[], world: Landmark[], cam: Pick<CameraModel, 'aspect' | 'focal'>): Vec3 | null {
  const idx = [LM.lSh, LM.rSh, LM.lHip, LM.rHip];
  if (idx.some((i) => !inFrame(img[i]) || (img[i].visibility ?? 1) < MIN_VISIBILITY)) return null;
  const pairs = [[LM.lSh, LM.rSh], [LM.lHip, LM.rHip], [LM.lSh, LM.lHip], [LM.rSh, LM.rHip], [LM.lSh, LM.rHip], [LM.rSh, LM.lHip]];
  let metric = 0,
    pixels = 0;
  for (const [i, j] of pairs) {
    metric += Math.hypot(world[i].x - world[j].x, world[i].y - world[j].y);
    pixels += Math.hypot((img[i].x - img[j].x) * cam.aspect, img[i].y - img[j].y);
  }
  if (pixels < 1e-4) return null;
  const Z = (cam.focal * metric) / pixels;
  const u = (img[LM.lHip].x + img[LM.rHip].x) / 2 - 0.5;
  return [(u * cam.aspect * Z) / cam.focal, 0, -Z];
}

/** Eine Kamera: 3D-Pose direkt aus MediaPipe (Tiefe ist nur geschaetzt). */
export function measureMono(world: Landmark[] | null, img: Landmark[] | null, cam: CameraModel): Measurement {
  const pts: (Vec3 | null)[] = new Array(POSE_COUNT).fill(null);
  const vis: number[] = new Array(POSE_COUNT).fill(0);
  for (let i = 0; i < POSE_COUNT; i++) {
    if (!world || !okJoint(world, img, i)) continue;
    pts[i] = toThree(world[i]);
    vis[i] = world[i].visibility ?? 1;
  }
  return { pts, vis, root: world && img ? estimateRoot(img, world, cam) : null, nTri: 0 };
}

/** Zwei Kameras: Triangulation, wo beide das Gelenk sehen. null, wenn weniger als 4 Gelenke gelingen. */
export function measureStereo(
  worldA: Landmark[],
  imgA: Landmark[],
  worldB: Landmark[],
  imgB: Landmark[],
  pose: StereoPose,
  camA: CameraModel,
  camB: CameraModel,
): Measurement | null {
  const { R, T } = pose;
  const monoA = (i: number) => asVec(worldA[i]);
  const monoB = (i: number) => mulMtV(R, asVec(worldB[i]));

  const tri: (Vec3 | null)[] = new Array(POSE_COUNT).fill(null);
  let offA: Vec3 = [0, 0, 0],
    offB: Vec3 = [0, 0, 0],
    n = 0;
  for (let i = 0; i < POSE_COUNT; i++) {
    if (!okJoint(worldA, imgA, i) || !okJoint(worldB, imgB, i)) continue;
    const X = triangulate(camA.normalize(imgA[i]), camB.normalize(imgB[i]), R, T);
    if (!X) continue;
    tri[i] = X;
    offA = add(offA, sub(X, monoA(i)));
    offB = add(offB, sub(X, monoB(i)));
    n++;
  }
  if (n < 4) return null;
  offA = scale(offA, 1 / n); // = Position der Huefte in Kamera A
  offB = scale(offB, 1 / n);

  const pts: (Vec3 | null)[] = new Array(POSE_COUNT).fill(null);
  const abs: (Vec3 | null)[] = new Array(POSE_COUNT).fill(null);
  const vis: number[] = new Array(POSE_COUNT).fill(0);
  let nTri = 0;
  for (let i = 0; i < POSE_COUNT; i++) {
    const a = okJoint(worldA, imgA, i),
      b = okJoint(worldB, imgB, i);
    let P: Vec3 | null = null;
    const Ti = tri[i];
    if (Ti) {
      // Grobe Ausreisser (z.B. links/rechts vertauscht) verwerfen.
      const guess = add(monoA(i), offA);
      if (norm(sub(Ti, guess)) < 0.4) {
        P = Ti;
        nTri++;
      } else P = guess;
    } else if (a) P = add(monoA(i), offA);
    else if (b) P = add(monoB(i), offB);
    if (!P) continue;
    abs[i] = P;
    pts[i] = camToThree(sub(P, offA));
    vis[i] = Math.max(a ? (worldA[i].visibility ?? 1) : 0, b ? (worldB[i].visibility ?? 1) : 0);
  }
  return { pts, abs, vis, root: [offA[0], 0, -offA[2]], nTri };
}

/**
 * Beobachtungen einer Kamera fuer den EKF: entzerrter Bildpunkt und die 3D-Einzelschaetzung
 * relativ zur Huefte, ausgedrueckt in den Achsen von Kamera A. R: Drehung von A nach dieser
 * Kamera, null fuer Kamera A selbst.
 */
export function buildObs(world: Landmark[] | null, img: Landmark[] | null, cam: CameraModel, R: Mat3 | null): (JointObservation | null)[] {
  const obs: (JointObservation | null)[] = new Array(POSE_COUNT).fill(null);
  if (!world || !img) return obs;
  for (let i = 0; i < POSE_COUNT; i++) {
    if (!okJoint(world, img, i)) continue;
    const w = asVec(world[i]);
    obs[i] = { n: cam.normalize(img[i]), vis: world[i].visibility ?? 1, mono: R ? mulMtV(R, w) : w };
  }
  return obs;
}

/** Ein Bild fuer die Stereo-Kalibrierung: Gelenke, die beide Kameras sicher sehen (mindestens 6). */
export function calibrationFrame(
  worldA: Landmark[],
  imgA: Landmark[],
  worldB: Landmark[],
  imgB: Landmark[],
  camA: CameraModel,
  camB: CameraModel,
): CalibrationFrame | null {
  const frame: CalibrationFrame = { nA: [], nB: [], WA: [], WB: [] };
  for (const i of CALIB_JOINTS) {
    if (!okJoint(worldA, imgA, i, 0.6) || !okJoint(worldB, imgB, i, 0.6)) continue;
    frame.nA.push(camA.normalize(imgA[i]));
    frame.nB.push(camB.normalize(imgB[i]));
    frame.WA.push(asVec(worldA[i]));
    frame.WB.push(asVec(worldB[i]));
  }
  return frame.nA.length >= 6 ? frame : null;
}
