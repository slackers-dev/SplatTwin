// Erkennung pro Kamera: bevorzugt im Hintergrund-Strang (detect-worker.ts), sonst wie frueher
// im Hauptstrang. Die Kamera liefert ein Bild ab, sobald der Strang frei ist; das Ergebnis holt
// der Tracker beim naechsten Animationsbild ab. Damit laufen Kamera A, Kamera B und das Zeichnen
// gleichzeitig statt nacheinander.
import type { FaceLandmarker, HandLandmarker, NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision';
import { type FacePose, headCrop, quatFromMatrix } from '../core/face';
import type { HandDetection } from '../core/hands';
import type { Landmark } from '../core/landmarks';
import { createFaceLandmarker, createHandLandmarker, createPoseLandmarker, type PoseVariant } from './detectors';

/** Ergebnis fuer ein Bild einer Kamera. */
export interface Detection {
  /** Zeitpunkt, zu dem das Bild abgeholt wurde (performance.now) */
  t: number;
  /** Aufnahmezeit des Bildes (fuer den EKF, siehe FrameClock) */
  stamp: number;
  img: NormalizedLandmark[] | null;
  world: Landmark[] | null;
  hands: HandDetection | null;
  /** Kopf und Mund aus dem Gesichtsmodell (nur im Hauptstrang, sonst null) */
  face?: FacePose | null;
  /** Rechenzeit der Erkennung in ms */
  ms: number;
}

export type DetectRequest =
  | { type: 'init'; variant: PoseVariant; delegate: 'GPU' | 'CPU' }
  | { type: 'frame'; frame: ImageBitmap; t: number; fingers: boolean };

export type DetectResponse =
  | { type: 'ready' }
  | { type: 'error'; error: string }
  | { type: 'result'; t: number; img: NormalizedLandmark[] | null; world: Landmark[] | null; hands: HandDetection | null; ms: number };

export class CameraDetector {
  /** 'worker' = eigener Strang, 'inline' = Hauptstrang (Rueckfall) */
  mode: 'worker' | 'inline' = 'inline';
  private worker: Worker | null = null;
  private pose: PoseLandmarker | null = null;
  private hands: HandLandmarker | null = null;
  private face: FaceLandmarker | null = null;
  private faceLoading = false;
  private crop: HTMLCanvasElement | null = null;
  private busy = false;
  private latest: Detection | null = null;
  private pending: { t: number; stamp: number } | null = null;
  private lastSent = -1;
  private lastT = 0;
  error: string | null = null;
  /** Rechenzeit des letzten Bildes in ms, geglaettet */
  ms = 0;
  /** fertige Bilder pro Sekunde, geglaettet */
  fps = 0;
  private lastResult = 0;

  private constructor(
    private readonly variant: PoseVariant,
    private readonly delegate: 'GPU' | 'CPU',
  ) {}

  /** Startet die Erkennung; scheitert der Worker (oder inline = true), laeuft sie im Hauptstrang. */
  static async create(variant: PoseVariant, inline = false, delegate: 'GPU' | 'CPU' = 'GPU'): Promise<CameraDetector> {
    const d = new CameraDetector(variant, delegate);
    if (!inline) {
      try {
        await d.startWorker();
        d.mode = 'worker';
        return d;
      } catch (err) {
        console.warn('Erkennung im Hintergrund nicht moeglich, rechne im Hauptstrang:', err);
        d.worker?.terminate();
        d.worker = null;
      }
    }
    [d.pose, d.hands] = await Promise.all([createPoseLandmarker(variant, undefined, delegate), createHandLandmarker(undefined, delegate)]);
    return d;
  }

  private startWorker(): Promise<void> {
    const worker = new Worker(new URL('./detect-worker.ts', import.meta.url));
    this.worker = worker;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Zeitueberschreitung beim Laden')), 30000);
      worker.onerror = (e) => {
        clearTimeout(timeout);
        reject(new Error(e.message || 'Worker-Fehler'));
      };
      worker.onmessage = (e: MessageEvent<DetectResponse>) => {
        const msg = e.data;
        if (msg.type === 'ready') {
          clearTimeout(timeout);
          worker.onmessage = (ev: MessageEvent<DetectResponse>) => this.onResult(ev.data);
          resolve();
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          reject(new Error(msg.error));
        }
      };
      worker.postMessage({ type: 'init', variant: this.variant, delegate: this.delegate } satisfies DetectRequest);
    });
  }

  private onResult(msg: DetectResponse): void {
    this.busy = false;
    const sent = this.pending;
    this.pending = null;
    if (msg.type === 'error') {
      this.error = msg.error;
      return;
    }
    if (msg.type !== 'result' || !sent) return;
    this.error = null;
    this.latest = { t: msg.t, stamp: sent.stamp, img: msg.img, world: msg.world, hands: msg.hands, ms: msg.ms };
    this.ms += (msg.ms - this.ms) * 0.1;
  }

  /**
   * Neues Bild abgeben, wenn die Erkennung frei ist. stamp = Aufnahmezeit des Bildes.
   * Im Hauptstrang wird sofort gerechnet.
   */
  submit(video: HTMLVideoElement, now: number, stamp: number, fingers: boolean, face = false): void {
    if (this.busy || video.readyState < 2 || video.currentTime === this.lastSent) return;
    // Zeitstempel muessen fuer MediaPipe streng steigen.
    const t = Math.max(now, this.lastT + 1);
    this.lastT = t;
    this.lastSent = video.currentTime;
    if (this.mode === 'inline') {
      const start = performance.now();
      const p = this.pose!.detectForVideo(video, t);
      const h = fingers ? this.hands!.detectForVideo(video, t) : null;
      const img = p.landmarks?.[0] ?? null;
      this.latest = {
        t,
        stamp,
        img,
        world: p.worldLandmarks?.[0] ?? null,
        hands: h ? { landmarks: h.landmarks, worldLandmarks: h.worldLandmarks } : null,
        face: face && img ? this.detectFace(video, img, t) : null,
        ms: performance.now() - start,
      };
      this.ms += (this.latest.ms - this.ms) * 0.1;
      return;
    }
    this.busy = true;
    this.pending = { t, stamp };
    createImageBitmap(video)
      .then((frame) => this.worker!.postMessage({ type: 'frame', frame, t, fingers } satisfies DetectRequest, [frame]))
      .catch((err) => {
        this.busy = false;
        this.pending = null;
        this.error = String(err);
      });
  }

  /**
   * Kopf und Mund: Kopf aus dem Bild ausschneiden (core/face headCrop), auf 256 px vergroessern und
   * dem Gesichtsmodell geben. Im ganzen Bild findet es ein Gesicht ab etwa 2 m nicht mehr. Das Modell
   * laedt beim ersten Gebrauch (3.7 MB), bis dahin null.
   */
  private detectFace(video: HTMLVideoElement, img: NormalizedLandmark[], t: number): FacePose | null {
    if (!this.face) {
      if (!this.faceLoading) {
        this.faceLoading = true;
        createFaceLandmarker(this.delegate)
          .then((f) => (this.face = f))
          .catch((err) => console.warn('Gesichtsmodell nicht geladen:', err));
      }
      return null;
    }
    const box = headCrop(img, video.videoWidth, video.videoHeight);
    if (!box) return null;
    const c = (this.crop ??= Object.assign(document.createElement('canvas'), { width: 256, height: 256 }));
    const g = c.getContext('2d', { willReadFrequently: false })!;
    g.fillStyle = '#000';
    g.fillRect(0, 0, 256, 256);
    g.drawImage(video, box.x, box.y, box.size, box.size, 0, 0, 256, 256);
    const r = this.face.detectForVideo(c, t);
    const m = r.facialTransformationMatrixes?.[0]?.data;
    if (!m) return null;
    const jaw = r.faceBlendshapes?.[0]?.categories.find((k) => k.categoryName === 'jawOpen')?.score ?? 0;
    return { q: quatFromMatrix(m), jaw };
  }

  /** Neuestes, noch nicht abgeholtes Ergebnis. */
  take(): Detection | null {
    const d = this.latest;
    this.latest = null;
    if (d) {
      if (this.lastResult && d.t > this.lastResult) this.fps += (1000 / (d.t - this.lastResult) - this.fps) * 0.1;
      this.lastResult = d.t;
    }
    return d;
  }

  /** Neue Quelle: offenes Bild vergessen. */
  reset(): void {
    this.lastSent = -1;
    this.latest = null;
  }
}
