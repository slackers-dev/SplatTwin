// Tracking pro Bild: Koerper- und Handerkennung, 3D-Messung (eine oder zwei Kameras), Filter.
//
// Eine Kamera:   MediaPipe schaetzt die 3D-Pose, ein Kalman-Filter pro Gelenk glaettet.
// Zwei Kameras:  nach der Stereo-Kalibrierung trianguliert; ein Extended Kalman Filter fuehrt
//                beide Kameras zusammen, jede zu ihrem eigenen Aufnahmezeitpunkt.
//
// Die Klasse kennt keine Bedienelemente: die Seite gibt die Einstellungen pro Bild mit und
// entscheidet, was sie mit dem Ergebnis macht (Avatar, Vorschau, Live senden).
import type { HandLandmarker, NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision';
import { type JointObservation, SkeletonEKF } from '../core/ekf';
import { assignHands, type Hands, SIDES } from '../core/hands';
import { KalmanPoint } from '../core/kalman';
import { camToThree, HAND_COUNT, LM, type Landmark, POSE_COUNT } from '../core/landmarks';
import { buildObs, calibrationFrame, type Measurement, measureMono, measureStereo } from '../core/measure';
import { type CalibrationFrame, calibrate, type StereoCalibration, type StereoPose } from '../core/stereo';
import { add, IDENTITY, scale, sub, type Vec3 } from '../core/vec';
import type { CameraSetup } from './cameras';
import { FrameClock } from './frame-clock';

const STALE_MS = 200; // aelter darf das Bild der zweiten Kamera nicht sein
const LOST_TIMEOUT_FRAMES = 30; // danach gilt ein Gelenk als unbekannt (Ruhepose)
const HAND_TIMEOUT_FRAMES = 15; // so lange laeuft eine verlorene Hand per Vorhersage weiter
export const CALIB_SECONDS = 12;

export interface Detectors {
  pose: PoseLandmarker;
  /** eigene Instanz fuer Kamera B: im Video-Modus merkt sich das Modell den Verlauf */
  poseB: PoseLandmarker;
  hands: HandLandmarker;
}

export interface TrackSettings {
  /** Prozessrauschen in m/s² */
  sigmaA: number;
  /** Messrauschen in m */
  sigmaZ: number;
  fingers: boolean;
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
  /** Position im Raum (x, 0, z): Messung und gefiltert; origin = Bezugspunkt fuer "Bewegung im Raum" */
  rawRoot: Vec3 | null;
  root: Vec3 | null;
  origin: Vec3 | null;
  mode: 'mono' | 'stereo';
  nTri: number;
  fused: number;
  rejected: number;
  fps: number;
  calibration: CalibrationProgress | null;
}

/** Ergebnis eines neuen Bildes von Kamera B (nur fuer die Vorschau). */
export interface TrackFrameB {
  img: NormalizedLandmark[] | null;
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
  private lastVideoTime = -1;
  private lastStamp = 0;
  private fps = 0;
  private rootOrigin: Vec3 | null = null;
  private lastMode: 'mono' | 'stereo' = 'mono';
  private collecting: { start: number; frames: CalibrationFrame[] } | null = null;
  private readonly camB = {
    lastTime: -1,
    stamp: -Infinity,
    world: null as Landmark[] | null,
    img: null as NormalizedLandmark[] | null,
    rejected: 0,
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
    this.lastVideoTime = -1;
    this.lastStamp = 0;
    this.rootOrigin = null;
    this.rootFilter.reset();
    this.filters.forEach((f) => f.reset());
    SIDES.forEach((s) => this.handFilters[s].forEach((f) => f.reset()));
  }

  /** Neue Quelle fuer Kamera B. */
  resetB(): void {
    this.camB.lastTime = -1;
    this.camB.stamp = -Infinity;
  }

  /** Aktuelle Position wird zum Bezugspunkt ("Position zuruecksetzen"). */
  recenter(): void {
    this.rootOrigin = null;
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
    const video = this.videoB,
      b = this.camB;
    if (video.readyState < 2 || video.currentTime === b.lastTime) return null;
    b.lastTime = video.currentTime;
    const result = this.detectors.poseB.detectForVideo(video, now);
    b.world = result.worldLandmarks?.[0] ?? null;
    b.img = result.landmarks?.[0] ?? null;
    b.stamp = now;
    // Kamera B korrigiert den Filter zu ihrem eigenen Aufnahmezeitpunkt.
    if (this.stereo && this.lastMode === 'stereo') {
      const obs = buildObs(b.world, b.img, this.cameras.model('B'), this.stereo.R);
      this.ekf.updateCamera(this.clockB.stamp(now), obs, this.stereo.R, this.stereo.T, settings);
      b.rejected = this.ekf.rejected;
    }
    return { img: b.img };
  }

  /** Kamera A: das ganze Tracking fuer ein neues Bild. null = kein neues Bild. */
  stepA(now: number, settings: TrackSettings): TrackFrame | null {
    const video = this.videoA;
    if (video.readyState < 2 || video.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = video.currentTime;

    const dt = this.lastStamp ? Math.min((now - this.lastStamp) / 1000, 0.1) : 1 / 30;
    if (this.lastStamp) this.fps += (1 / dt - this.fps) * 0.1;
    this.lastStamp = now;

    const result = this.detectors.pose.detectForVideo(video, now);
    const world: Landmark[] | null = result.worldLandmarks?.[0] ?? null;
    const img: NormalizedLandmark[] | null = result.landmarks?.[0] ?? null;
    const { sigmaA, sigmaZ } = settings;
    const hands = this.trackHands(now, img, dt, settings);

    const b = this.camB;
    const bFresh = now - b.stamp < STALE_MS;
    const calibration = this.collecting ? this.collect(now, world, img, bFresh ? b.world : null, b.img) : null;

    const camA = this.cameras.model('A');
    // Gelenke ausserhalb des Bildes raet das Modell nur: nicht als Messung verwenden.
    let m: Measurement | null = null;
    if (this.stereo && world && img && bFresh && b.world && b.img) {
      m = measureStereo(world, img, b.world, b.img, this.stereo, camA, this.cameras.model('B'));
    }
    const mode = m ? 'stereo' : 'mono';
    if (!m) m = measureMono(world, img, camA);
    if (mode !== this.lastMode) {
      // Die Positionen beider Verfahren sind nicht deckungsgleich: neu einmitten.
      this.lastMode = mode;
      this.rootOrigin = null;
      this.rootFilter.reset();
      this.ekf.reset();
    }

    // Zwei Kameras: Kamera A korrigiert den EKF, unbekannte Gelenke starten bei der Triangulation.
    let fused: (Vec3 | null)[] | null = null,
      fusedRoot: Vec3 | null = null,
      rejected = 0;
    if (mode === 'stereo') {
      const abs = m.abs ?? [];
      const obs: (JointObservation | null)[] = buildObs(world, img, camA, null);
      this.ekf.updateCamera(this.clockA.stamp(now), obs, IDENTITY, [0, 0, 0], { sigmaA, sigmaZ, init: (i) => abs[i] });
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
    if (rawRoot && !this.rootOrigin) this.rootOrigin = [rawRoot[0], rawRoot[1], rawRoot[2]];
    const root: Vec3 | null = fused
      ? fusedRoot
        ? [fusedRoot[0], 0, -fusedRoot[2]]
        : null
      : this.rootFilter.step(rawRoot, dt, sigmaA / 4, sigmaZ * 3);

    return {
      img,
      handsImg: hands.img,
      personSeen: !!world,
      raw,
      filtered,
      rawHands: hands.raw,
      filteredHands: hands.filtered,
      rawRoot,
      root: root ? [root[0], root[1], root[2]] : null,
      origin: this.rootOrigin,
      mode,
      nTri: m.nTri,
      fused: fused ? fused.filter(Boolean).length : 0,
      rejected,
      fps: this.fps,
      calibration,
    };
  }

  private trackHands(now: number, img: NormalizedLandmark[] | null, dt: number, settings: TrackSettings) {
    const active = settings.fingers;
    const result = active ? this.detectors.hands.detectForVideo(this.videoA, now) : null;
    const measured = assignHands(result, img);
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
    return { raw, filtered, img: result?.landmarks ?? [] };
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
