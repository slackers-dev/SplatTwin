// Weiche Bewegung aus wenigen Bildern: Die Tracking-Seite schickt oft nur 10 bis 30 Bilder pro Sekunde,
// der Bildschirm zeigt 60 oder mehr. Zwischen dem zuletzt gezeigten Stand und dem neuesten Bild wird
// ueber die Zeit uebergeblendet, die zwischen den beiden Bildern beim Sender lag. Kostet etwa ein Bild
// Verzoegerung; ein neues Bild startet dort, wo die Ueberblendung gerade steht (kein Springen).
import type { LiveFrame } from '../contracts';
import type { Vec3 } from './vec';

type Points = (Vec3 | null)[];

/** Punkt zwischen a und b; fehlt einer, gilt der neuere (b). */
export function mixPoint(a: Vec3 | null | undefined, b: Vec3 | null, k: number): Vec3 | null {
  if (!a || !b) return b;
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

export function mixPoints(a: Points | null | undefined, b: Points | null, k: number): Points | null {
  return b ? b.map((p, i) => mixPoint(a?.[i], p, k)) : null;
}

export function mixFrames(a: LiveFrame, b: LiveFrame, k: number): LiveFrame {
  return {
    ...b,
    pos: [a.pos[0]! + (b.pos[0]! - a.pos[0]!) * k, a.pos[1]! + (b.pos[1]! - a.pos[1]!) * k],
    pts: mixPoints(a.pts, b.pts, k)!,
    hands: { Left: mixPoints(a.hands.Left, b.hands.Left, k), Right: mixPoints(a.hands.Right, b.hands.Right, k) },
  };
}

const MIN_SPAN = 16; // ms: nie schneller als ein Bildschirmbild
const MAX_SPAN = 250; // ms: nach einer Pause nicht ewig hinterherziehen

export class FrameBlend {
  private from: LiveFrame | null = null;
  private to: LiveFrame | null = null;
  private recv = 0;
  private span = MIN_SPAN;
  private shown: LiveFrame | null = null;
  /** Empfangszeit des letzten Bildes (ms), 0 = noch keines */
  lastTime = 0;

  receive(frame: LiveFrame, now: number): void {
    // Start ist, was gerade zu sehen ist, nicht das vorige Bild.
    this.from = this.shown ?? this.to;
    if (this.to) this.span = Math.max(MIN_SPAN, Math.min(MAX_SPAN, frame.t - this.to.t || now - this.recv));
    this.to = frame;
    this.recv = now;
    this.lastTime = now;
  }

  /** Stand zum Zeitpunkt now, null vor dem ersten Bild. */
  sample(now: number): LiveFrame | null {
    if (!this.to) return null;
    const k = this.from ? Math.min(1, (now - this.recv) / this.span) : 1;
    this.shown = k < 1 && this.from ? mixFrames(this.from, this.to, k) : this.to;
    return this.shown;
  }
}
