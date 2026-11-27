// Erkennung pro Kamera: bevorzugt im Hintergrund-Strang (detect-worker.ts), sonst wie frueher
// im Hauptstrang. Die Kamera liefert ein Bild ab, sobald der Strang frei ist; das Ergebnis holt
// der Tracker beim naechsten Animationsbild ab. Damit laufen Kamera A, Kamera B und das Zeichnen
// gleichzeitig statt nacheinander.
import type { HandLandmarker, NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { HandDetection } from '../core/hands';
import type { Landmark } from '../core/landmarks';
import { createHandLandmarker, createPoseLandmarker, type PoseVariant } from './detectors';

/** Ergebnis fuer ein Bild einer Kamera. */
export interface Detection {
  /** Zeitpunkt, zu dem das Bild abgeholt wurde (performance.now) */
  t: number;
  /** Aufnahmezeit des Bildes (fuer den EKF, siehe FrameClock) */
  stamp: number;
  img: NormalizedLandmark[] | null;
  world: Landmark[] | null;
  hands: HandDetection | null;
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
  submit(video: HTMLVideoElement, now: number, stamp: number, fingers: boolean): void {
    if (this.busy || video.readyState < 2 || video.currentTime === this.lastSent) return;
    // Zeitstempel muessen fuer MediaPipe streng steigen.
    const t = Math.max(now, this.lastT + 0.01);
    this.lastT = t;
    this.lastSent = video.currentTime;
    if (this.mode === 'inline') {
      const start = performance.now();
      const p = this.pose!.detectForVideo(video, t);
      const h = fingers ? this.hands!.detectForVideo(video, t) : null;
      this.latest = {
        t,
        stamp,
        img: p.landmarks?.[0] ?? null,
        world: p.worldLandmarks?.[0] ?? null,
        hands: h ? { landmarks: h.landmarks, worldLandmarks: h.worldLandmarks } : null,
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
