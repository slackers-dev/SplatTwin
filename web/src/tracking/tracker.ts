// Tracking pro Bild: Koerper- und Handerkennung, 3D-Messung (eine oder zwei Kameras), Filter.
//
// Eine Kamera:   MediaPipe schaetzt die 3D-Pose, ein Kalman-Filter pro Gelenk glaettet.
// Zwei Kameras:  nach der Stereo-Kalibrierung trianguliert; ein Extended Kalman Filter fuehrt
//                beide Kameras zusammen, jede zu ihrem eigenen Aufnahmezeitpunkt.
//
// Die Klasse kennt keine Bedienelemente: die Seite gibt die Einstellungen pro Bild mit und
// entscheidet, was sie mit dem Ergebnis macht (Avatar, Vorschau, Live senden).
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { type JointObservation, SkeletonEKF } from '../core/ekf';
import { assignHands, type HandDetection, type Hands, SIDES } from '../core/hands';
import { KalmanPoint } from '../core/kalman';
import { OneEuroGroup, OneEuroPoint, smoothingParams } from '../core/one-euro';
import { limitBody, type LimitReport } from '../core/body-limits';
import { PoseHold } from '../core/pose-hold';
import { camToThree, HAND_COUNT, LM, type Landmark, POSE_COUNT } from '../core/landmarks';
import { buildObs, calibrationFrame, type Measurement, measureMono, measureStereo } from '../core/measure';
import { type CalibrationFrame, calibrate, type StereoCalibration, type StereoPose } from '../core/stereo';
import { add, IDENTITY, type Mat3, mulMtV, scale, sub, type Vec3 } from '../core/vec';
import type { CameraSetup } from './cameras';
import type { CameraDetector } from './detection';
import { FrameClock } from './frame-clock';
import { type FacePose, mixFace } from '../core/face';
import { StandingHeight } from '../core/height';
import { Settle } from '../core/settle';

const STALE_MS = 200; // aelter darf das Bild der zweiten Kamera nicht sein
// So lange bleibt der EKF im Stereo-Modus, wenn Kamera B kurz ausfaellt (Bild zu alt, Person
// verdeckt): Kamera A korrigiert allein weiter. Ohne diese Spanne setzte jeder kurze Aussetzer
// den Filter zurueck, und die Figur sprang (Zucken nach dem Kalibrieren).
const STEREO_HOLD_MS = 1500;
// Hoechstens so viel aelter (Aufnahmezeit) darf das Bild von Kamera B sein als das von A. Kommen
// die Handybilder verzoegert an (WLAN), passen die Gelenke beider Kameras nicht mehr zusammen:
// Triangulation und EKF springen. Dann lieber mit einer Kamera weiter.
const MAX_LAG_MS = 250;
const FACE_HOLD_S = 0.4; // so lange haelt der Kopf seine Haltung, wenn das Gesicht kurz fehlt
const LOST_TIMEOUT_FRAMES = 30; // danach gilt ein Gelenk als unbekannt (Ruhepose)
const HAND_TIMEOUT_FRAMES = 15; // so lange laeuft eine verlorene Hand per Vorhersage weiter
export const CALIB_SECONDS = 12;

/** Erkennung je Kamera, jede in ihrem eigenen Strang (siehe detection.ts). */
export interface Detectors {
  A: CameraDetector;
  B: CameraDetector;
}

export interface TrackSettings {
  /** Prozessrauschen in m/s² */
  sigmaA: number;
  /** Messrauschen in m */
  sigmaZ: number;
  fingers: boolean;
  /** Kopf und Mund mit dem Gesichtsmodell (nur Kamera A) */
  face?: boolean;
  /** adaptive Glaettung nach dem Filter, 0 = aus, 1 = sehr ruhig */
  smoothing: number;
}

export type CalibrationProgress =
  | { state: 'collecting'; left: number; frames: number }
  | { state: 'done'; result: StereoCalibration }
  | { state: 'failed'; error: string };

/** Ergebnis eines Bildes von Kamera A. */
export interface TrackFrame {
  /** Bildpunkte von Kamera A, fuer die Vorschau */
  img: NormalizedLandmark[] | null;
  handsImg: NormalizedLandmark[][];
  personSeen: boolean;
  /** Gelenke relativ zur Huefte (Achsen des Avatars): Messung und gefiltert */
  raw: (Vec3 | null)[];
  filtered: (Vec3 | null)[];
  rawHands: Hands<Vec3[]>;
  filteredHands: Hands<Vec3[]>;
  /** Wie oft Koerpergrenzen eingegriffen haben (nur gefilterte Punkte). */
  limits: LimitReport;
  /** Position im Raum (x, 0, z): Messung und gefiltert; origin = Bezugspunkt fuer "Bewegung im Raum" */
  rawRoot: Vec3 | null;
  root: Vec3 | null;
  origin: Vec3 | null;
  /** Hoehe der Huefte relativ zum aufrechten Stehen in m (in die Knie: negativ), null wenn unbekannt */
  height: number | null;
  /** Kopf und Mund aus dem Gesichtsmodell, geglaettet; null ohne Gesicht (z. B. von hinten) */
  face: FacePose | null;
  mode: 'mono' | 'stereo';
  nTri: number;
  /** Wechsel zwischen Stereo und einer Kamera seit dem Start (jeder setzt den Filter zurueck) */
  modeSwitches: number;
  /** Alter des letzten Bildes von Kamera B in ms (Aufnahmezeit A minus B), null ohne B */
  lagB: number | null;
  fused: number;
  rejected: number;
  fps: number;
  calibration: CalibrationProgress | null;
}

/** Ergebnis eines neuen Bildes von Kamera B (nur fuer die Vorschau). */
export interface TrackFrameB {
  img: NormalizedLandmark[] | null;
  handsImg: NormalizedLandmark[][];
}

export class Tracker {
  /** Relative Pose von Kamera B nach der Kalibrierung, null = eine Kamera */
  stereo: StereoPose | null = null;

  private readonly clockA: FrameClock;
  private readonly clockB: FrameClock;
  private readonly ekf = new SkeletonEKF(POSE_COUNT);
  private readonly filters = Array.from({ length: POSE_COUNT }, () => new KalmanPoint());
  private readonly rootFilter = new KalmanPoint();
  private readonly missing = new Array<number>(POSE_COUNT).fill(0);
  private readonly handFilters = { Left: hand(), Right: hand() };
  private readonly handMissing = { Left: 0, Right: 0 };
  // Letzte Glaettung nach Kalman/EKF (One-Euro): Skelett, Haende, Position im Raum
  private readonly smoothBody = new OneEuroGroup(POSE_COUNT);
  private readonly smoothHands = { Left: new OneEuroGroup(HAND_COUNT), Right: new OneEuroGroup(HAND_COUNT) };
  private readonly smoothRoot = new OneEuroPoint();
  /** Verlorene Gelenke einfrieren statt in die Ruhehaltung springen lassen. */
  private readonly hold = new PoseHold();
  private readonly standing = new StandingHeight();
  private face: FacePose | null = null;
  private faceLost = 0;
  private lastStamp = 0;
  private fps = 0;
  private rootOrigin: Vec3 | null = null;
  private readonly originSettle = new Settle();
  private lastMode: 'mono' | 'stereo' = 'mono';
  private lastStereoAt = -Infinity;
  private modeSwitches = 0;
  private lastStampB: number | null = null;
  private lastStampA: number | null = null;
  private collecting: { start: number; frames: CalibrationFrame[] } | null = null;
  private readonly camB = {
    stamp: -Infinity,
    world: null as Landmark[] | null,
    img: null as NormalizedLandmark[] | null,
    rejected: 0,
    /** Haende von Kamera B in Achsen des Avatars von Kamera A (nur mit Stereo-Kalibrierung) */
    hands: { Left: null, Right: null } as Hands<Vec3[]>,
  };

  constructor(
    private readonly detectors: Detectors,
    private readonly videoA: HTMLVideoElement,
    private readonly videoB: HTMLVideoElement,
    private readonly cameras: CameraSetup,
    /** Mit dem Messband gemessener Kameraabstand (Splattwin-App), legt den Massstab genauer fest. */
    private readonly measuredBaseline: () => number | null = () => null,
  ) {
    this.clockA = new FrameClock(videoA);
    this.clockB = new FrameClock(videoB);
  }

  get calibrating(): boolean {
    return this.collecting !== null;
  }

  /** Neue Quelle fuer Kamera A: Filter und Bezugspunkt neu. */
  reset(): void {
    this.detectors.A.reset();
    this.lastStamp = 0;
    this.rootOrigin = null;
    this.originSettle.reset();
    this.rootFilter.reset();
    this.filters.forEach((f) => f.reset());
    SIDES.forEach((s) => this.handFilters[s].forEach((f) => f.reset()));
    this.smoothBody.reset();
    SIDES.forEach((s) => this.smoothHands[s].reset());
    this.smoothRoot.reset();
    this.hold.reset();
    this.standing.reset();
    this.face = null;
  }

  /** Neue Quelle fuer Kamera B. */
  resetB(): void {
    this.detectors.B.reset();
    this.camB.stamp = -Infinity;
  }

  /** Aktuelle Position wird zum Bezugspunkt ("Position zuruecksetzen"). */
  recenter(): void {
    this.rootOrigin = null;
    this.originSettle.reset();
    this.standing.reset(); // aufrecht stehen und zuruecksetzen: neuer Bezug fuer die Hoehe
  }

  startCalibration(now: number): void {
    this.stereo = null;
    this.collecting = { start: now, frames: [] };
  }

  cancelCalibration(): void {
    this.collecting = null;
  }

  /** Kamera B: eigene Pose-Erkennung, Ergebnis wird mit Zeitstempel gemerkt. null = kein neues Bild. */
  stepB(now: number, settings: TrackSettings): TrackFrameB | null {
    const b = this.camB;
    const det = this.detectors.B;
    // Neues Bild abgeben (falls die Erkennung frei ist), fertiges Ergebnis abholen.
    det.submit(this.videoB, now, this.clockB.stamp(now), settings.fingers);
    const d = det.take();
    if (!d) return null;
    b.world = d.world;
    b.img = d.img;
    b.stamp = d.t;
    // Finger auch vom Handy: springen ein, wenn Kamera A eine Hand nicht sieht (z.B. verdeckt).
    let handsImg: NormalizedLandmark[][] = [];
    b.hands = { Left: null, Right: null };
    if (settings.fingers && d.hands) {
      const hands = d.hands;
      handsImg = hands.landmarks as NormalizedLandmark[][];
      if (this.stereo) {
        const measured = assignHands(hands, b.img);
        for (const side of SIDES) b.hands[side] = measured[side]?.map((p) => fromCamB(p, this.stereo!.R)) ?? null;
      }
    }
    // Kamera B korrigiert den Filter zu ihrem eigenen Aufnahmezeitpunkt.
    this.lastStampB = d.stamp;
    const lag = this.lastStampA === null ? 0 : this.lastStampA - d.stamp;
    if (this.stereo && this.lastMode === 'stereo' && lag < MAX_LAG_MS) {
      const obs = buildObs(b.world, b.img, this.cameras.model('B'), this.stereo.R);
      this.ekf.updateCamera(d.stamp, obs, this.stereo.R, this.stereo.T, settings);
      b.rejected = this.ekf.rejected;
    }
    return { img: b.img, handsImg };
  }

  /** Kamera A: das ganze Tracking fuer ein neues Bild. null = kein neues Bild. */
  stepA(now: number, settings: TrackSettings): TrackFrame | null {
    const det = this.detectors.A;
    det.submit(this.videoA, now, this.clockA.stamp(now), settings.fingers, !!settings.face);
    const d = det.take();
    if (!d) return null;
    // Ab hier zaehlt der Zeitpunkt, zu dem das Bild abgeholt wurde, nicht der Moment des Ergebnisses.
    now = d.t;

    const dt = this.lastStamp ? Math.min(Math.max((now - this.lastStamp) / 1000, 1e-3), 0.1) : 1 / 30;
    if (this.lastStamp) this.fps += (1 / dt - this.fps) * 0.1;
    this.lastStamp = now;

    const world: Landmark[] | null = d.world;
    const img: NormalizedLandmark[] | null = d.img;
    const { sigmaA, sigmaZ } = settings;
    const b = this.camB;
    this.lastStampA = d.stamp;
    const lagB = this.lastStampB === null ? null : d.stamp - this.lastStampB;
    const bFresh = Math.abs(now - b.stamp) < STALE_MS && (lagB === null || lagB < MAX_LAG_MS);
    const hands = this.trackHands(d.hands, img, dt, settings, bFresh);

    const calibration = this.collecting ? this.collect(now, world, img, bFresh ? b.world : null, b.img) : null;

    const camA = this.cameras.model('A');
    // Gelenke ausserhalb des Bildes raet das Modell nur: nicht als Messung verwenden.
    let m: Measurement | null = null;
    if (this.stereo && world && img && bFresh && b.world && b.img) {
      m = measureStereo(world, img, b.world, b.img, this.stereo, camA, this.cameras.model('B'));
    }
    if (m) this.lastStereoAt = now;
    // Kurzer Ausfall von B: im Stereo-Modus bleiben, A korrigiert den EKF allein.
    const hold = !m && !!this.stereo && this.lastMode === 'stereo' && !!world && !!img && now - this.lastStereoAt < STEREO_HOLD_MS;
    const mode = m || hold ? 'stereo' : 'mono';
    if (!m) m = measureMono(world, img, camA);
    if (mode !== this.lastMode) {
      this.modeSwitches++;
      // Die Positionen beider Verfahren sind nicht deckungsgleich: neu einmitten.
      this.lastMode = mode;
      this.rootOrigin = null;
      this.originSettle.reset();
      this.rootFilter.reset();
      this.standing.reset();
      this.ekf.reset();
    }

    // Zwei Kameras: Kamera A korrigiert den EKF, unbekannte Gelenke starten bei der Triangulation.
    let fused: (Vec3 | null)[] | null = null,
      fusedRoot: Vec3 | null = null,
      rejected = 0;
    if (mode === 'stereo') {
      // Beim Halten liegt keine Triangulation vor (die Werte von measureMono liegen anders):
      // neue Gelenke starten dann bei der Einzelschaetzung des EKF.
      const abs = hold ? null : (m.abs ?? []);
      const obs: (JointObservation | null)[] = buildObs(world, img, camA, null);
      this.ekf.updateCamera(d.stamp, obs, IDENTITY, [0, 0, 0], { sigmaA, sigmaZ, init: abs ? (i) => abs[i] : null });
      rejected = this.ekf.rejected + b.rejected;
      fused = this.ekf.positions();
      const l = fused[LM.lHip],
        r = fused[LM.rHip];
      fusedRoot = l && r ? scale(add(l, r), 0.5) : this.ekf.offset;
    }

    const raw: (Vec3 | null)[] = new Array(POSE_COUNT).fill(null);
    const filtered: (Vec3 | null)[] = new Array(POSE_COUNT).fill(null);
    for (let i = 0; i < POSE_COUNT; i++) {
      const z = m.pts[i] ?? null;
      raw[i] = z;
      if (fused) {
        const f = fused[i];
        filtered[i] = f && fusedRoot ? camToThree(sub(f, fusedRoot)) : null;
        continue;
      }
      this.missing[i] = z ? 0 : this.missing[i]! + 1;
      if (this.missing[i]! > LOST_TIMEOUT_FRAMES) this.filters[i]!.reset();
      // Unsichere Messungen bekommen ein groesseres Messrauschen.
      const p = this.filters[i]!.step(z, dt, sigmaA, sigmaZ / Math.max(m.vis[i] ?? 0, 0.1));
      filtered[i] = p ? [p[0], p[1], p[2]] : null;
    }

    const rawRoot = m.root;
    // Nullpunkt fuer die Bewegung im Raum erst, wenn die Messung ruhig ist (core/settle).
    if (!this.rootOrigin) this.rootOrigin = this.originSettle.step(rawRoot);
    const root: Vec3 | null = fused
      ? fusedRoot
        ? [fusedRoot[0], -fusedRoot[1], -fusedRoot[2]]
        : null
      : this.rootFilter.step(rawRoot, dt, sigmaA / 4, sigmaZ * 3);

    // Letzte Stufe: adaptive Glaettung. In Ruhe ruhig, bei schneller Bewegung ohne viel Verzoegerung.
    const smooth = smoothingParams(settings.smoothing);
    const smoothed = this.smoothBody.step(filtered, dt, smooth) ?? filtered;
    const smoothedHands: Hands<Vec3[]> = { Left: null, Right: null };
    for (const side of SIDES) {
      const h = this.smoothHands[side].step(hands.filtered[side], dt, smooth);
      smoothedHands[side] = h && h.every(Boolean) ? (h as Vec3[]) : hands.filtered[side];
    }
    // Was ein Koerper nicht kann: verlorene Teile einfrieren, Haende nicht in Rumpf und Kopf, Knie nicht
    // nach vorne durchknicken. Zuerst die Hand am Handgelenk festhalten, dann die Grenzen.
    const limits: LimitReport = { pushed: 0, knees: 0 };
    const physical = limitBody(this.hold.step(smoothed, dt), limits);
    for (const side of SIDES) {
      const wrist = physical?.[side === 'Left' ? LM.lWr : LM.rWr] ?? null;
      smoothedHands[side] = this.hold.stepHand(side, smoothedHands[side], wrist, dt);
    }
    const face = this.smoothFace(d.face ?? null, dt, settings.smoothing);
    const smoothedRoot = root ? (smooth ? this.smoothRoot.step(root, dt, { ...smooth, minCutoff: smooth.minCutoff / 2 }) : root) : null;

    return {
      img,
      handsImg: hands.img,
      personSeen: !!world,
      raw,
      filtered: physical ?? smoothed,
      limits,
      rawHands: hands.raw,
      filteredHands: smoothedHands,
      rawRoot,
      root: smoothedRoot ? [smoothedRoot[0], smoothedRoot[1], smoothedRoot[2]] : null,
      origin: this.rootOrigin,
      face,
      height: this.standing.step(smoothedRoot ? smoothedRoot[1] : null, dt),
      mode,
      nTri: m.nTri,
      modeSwitches: this.modeSwitches,
      lagB,
      fused: fused ? fused.filter(Boolean).length : 0,
      rejected,
      fps: this.fps,
      calibration,
    };
  }

  /**
   * Kopf und Mund glaetten: je staerker die Glaettung, desto langsamer folgt der Kopf. Verliert das
   * Gesichtsmodell das Gesicht kurz (Blinzeln, Hand davor), bleibt der letzte Stand FACE_HOLD_S stehen,
   * danach null (der Kopf folgt wieder Nase und Ohren).
   */
  private smoothFace(m: FacePose | null, dt: number, smoothing: number): FacePose | null {
    if (!m) {
      this.faceLost += dt;
      if (this.faceLost > FACE_HOLD_S) this.face = null;
      return this.face;
    }
    this.faceLost = 0;
    // Anteil des neuen Werts pro Bild, umgerechnet auf die Bildrate (bei 30 Bilder/s: 1 bis 0.25).
    const k = 1 - Math.pow(1 - Math.max(0.25, 1 - 0.75 * smoothing), dt * 30);
    this.face = this.face ? mixFace(this.face, m, k) : m;
    return this.face;
  }

  private trackHands(result: HandDetection | null, img: NormalizedLandmark[] | null, dt: number, settings: TrackSettings, bFresh: boolean) {
    const active = settings.fingers;
    const measured = assignHands(result, img);
    // Sieht Kamera A eine Hand nicht, aber das Handy: dessen Finger nehmen.
    if (bFresh) for (const side of SIDES) measured[side] ??= this.camB.hands[side];
    const raw: Hands<Vec3[]> = { Left: null, Right: null };
    const filtered: Hands<Vec3[]> = { Left: null, Right: null };
    for (const side of SIDES) {
      const z = measured[side];
      this.handMissing[side] = z ? 0 : this.handMissing[side] + 1;
      if (!active || this.handMissing[side] > HAND_TIMEOUT_FRAMES) {
        this.handFilters[side].forEach((f) => f.reset());
        continue;
      }
      raw[side] = z;
      // Finger sind klein: Messrauschen entsprechend kleiner ansetzen.
      const pts = this.handFilters[side].map((f, i) => f.step(z?.[i] ?? null, dt, settings.sigmaA, settings.sigmaZ * 0.3));
      filtered[side] = pts.every((p) => p) ? pts.map((p) => [p![0], p![1], p![2]] as Vec3) : null;
    }
    return { raw, filtered, img: (result?.landmarks ?? []) as NormalizedLandmark[][] };
  }

  /** Sammelt waehrend der Kalibrierung Gelenke, die beide Kameras sicher sehen. */
  private collect(
    now: number,
    worldA: Landmark[] | null,
    imgA: Landmark[] | null,
    worldB: Landmark[] | null,
    imgB: Landmark[] | null,
  ): CalibrationProgress {
    const c = this.collecting!;
    if (worldA && imgA && worldB && imgB) {
      const frame = calibrationFrame(worldA, imgA, worldB, imgB, this.cameras.model('A'), this.cameras.model('B'));
      if (frame) c.frames.push(frame);
    }
    const left = CALIB_SECONDS - (now - c.start) / 1000;
    if (left > 0) return { state: 'collecting', left, frames: c.frames.length };
    this.collecting = null;
    try {
      const result = calibrate(c.frames);
      // Gemessener Kameraabstand aus der App: genauer als die Koerperschaetzung. Die Richtung der
      // Verschiebung bleibt, nur ihre Laenge wird ersetzt.
      const measured = this.measuredBaseline();
      if (measured && measured > 0 && result.baseline > 0) {
        result.T = scale(result.T, measured / result.baseline);
        result.baseline = measured;
      }
      this.stereo = { R: result.R, T: result.T };
      return { state: 'done', result };
    } catch (err) {
      return { state: 'failed', error: (err as Error).message };
    }
  }
}

function hand(): KalmanPoint[] {
  return Array.from({ length: HAND_COUNT }, () => new KalmanPoint());
}

/**
 * Punkt in Achsen des Avatars, gemessen von Kamera B -> Achsen des Avatars von Kamera A.
 * Avatar-Achsen = Kameraachsen mit gespiegeltem y und z (D = diag(1, -1, -1)), also D R^T D.
 */
function fromCamB(p: Vec3, R: Mat3): Vec3 {
  const q = mulMtV(R, [p[0], -p[1], -p[2]]);
  return [q[0], -q[1], -q[2]];
}
