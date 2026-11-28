// Weiche Bewegung aus wenigen Bildern: Die Tracking-Seite schickt 10 bis 30 Bilder pro Sekunde, der
// Bildschirm zeigt 60 oder mehr, und die Bilder kommen unregelmaessig an (Netz, Server, Browser: mal zwei
// kurz nacheinander, mal eine Luecke).
//
// Darum ein kleiner Puffer wie bei Online-Spielen: Die Buehne spielt die Bilder mit kurzer Verzoegerung
// genau im Takt ab, in dem der Sender sie erzeugt hat (Zeitstempel t), und blendet zwischen den beiden
// Bildern, die den Abspielzeitpunkt einrahmen. So laeuft die Bewegung so gleichmaessig wie auf der
// Tracking-Seite, und Geschwindigkeiten stimmen (wichtig fuer die Drehbegrenzung im Avatar). Die
// Verzoegerung passt sich an: ein Bildabstand plus die groesste Schwankung der Laufzeit, 60 bis 250 ms.
import type { LiveFrame } from '../contracts';
import { mixFace } from './face';
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

// Rumpf: Schultern und Hueften. Springt einer davon zwischen zwei Bildern weiter als TORSO_JUMP, wird nicht
// uebergeblendet: Dreht sich die Person oder vertauscht die Erkennung links und rechts (von hinten
// haeufig), fielen Schultern und Hueften im Zwischenbild fast auf einen Punkt. Daraus ist keine Richtung
// mehr abzulesen, und der Avatar kippte auf der Buehne um (die Tracking-Seite blendet nicht ueber).
const TORSO = [11, 12, 23, 24];
const TORSO_JUMP = 0.15; // m

/** Lohnt sich das Ueberblenden von a nach b, oder springt der Rumpf? */
export function blendable(a: LiveFrame, b: LiveFrame): boolean {
  for (const i of TORSO) {
    const p = a.pts[i],
      q = b.pts[i];
    if (!p || !q) continue;
    if (Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > TORSO_JUMP) return false;
  }
  return true;
}

export function mixFrames(a: LiveFrame, b: LiveFrame, k: number): LiveFrame {
  if (!blendable(a, b)) return b;
  return {
    ...b,
    pos: [a.pos[0]! + (b.pos[0]! - a.pos[0]!) * k, a.pos[1]! + (b.pos[1]! - a.pos[1]!) * k],
    height: a.height === null || b.height === null ? b.height : a.height + (b.height - a.height) * k,
    pts: mixPoints(a.pts, b.pts, k)!,
    hands: { Left: mixPoints(a.hands.Left, b.hands.Left, k), Right: mixPoints(a.hands.Right, b.hands.Right, k) },
    face: mixFace(a.face, b.face, k),
  };
}

const MIN_DELAY = 60; // ms
const MAX_DELAY = 250; // ms
const KEEP_MS = 1000; // so lange bleiben Bilder im Puffer
const OFFSET_WINDOW = 3000; // ms: kleinste Laufzeit in diesem Fenster gilt als Uhrenabstand
const RESTART_MS = 1000; // springt die Senderzeit so weit zurueck, hat der Sender neu gestartet

export class FrameBlend {
  private frames: LiveFrame[] = [];
  private offsets: { at: number; off: number }[] = [];
  private interval = 50;
  /** Empfangszeit des letzten Bildes (ms), 0 = noch keines */
  lastTime = 0;

  receive(frame: LiveFrame, now: number): void {
    const last = this.frames.at(-1);
    if (last && frame.t <= last.t) {
      if (last.t - frame.t < RESTART_MS) return; // altes Bild, schon ueberholt
      this.frames = [];
      this.offsets = [];
    } else if (last) {
      this.interval += (Math.min(250, frame.t - last.t) - this.interval) * 0.1;
    }
    this.frames.push(frame);
    this.lastTime = now;
    // Uhrenabstand Empfaenger - Sender: die kuerzeste Laufzeit der letzten Sekunden (Verzoegerungen im
    // Netz machen sie nur laenger, nie kuerzer).
    this.offsets.push({ at: now, off: now - frame.t });
    while (this.offsets.length > 1 && now - this.offsets[0]!.at > OFFSET_WINDOW) this.offsets.shift();
    while (this.frames.length > 2 && frame.t - this.frames[0]!.t > KEEP_MS) this.frames.shift();
  }

  /** Verzoegerung beim Abspielen in ms: Bildabstand plus Schwankung der Laufzeit, damit das naechste Bild da ist. */
  get delay(): number {
    const offs = this.offsets.map((o) => o.off);
    const jitter = offs.length ? Math.max(...offs) - Math.min(...offs) : 0;
    return Math.max(MIN_DELAY, Math.min(MAX_DELAY, this.interval + jitter + 10));
  }

  /** Stand zum Zeitpunkt now, null vor dem ersten Bild. */
  sample(now: number): LiveFrame | null {
    const frames = this.frames;
    if (!frames.length) return null;
    const offset = Math.min(...this.offsets.map((o) => o.off));
    const target = now - offset - this.delay; // Abspielzeit in der Uhr des Senders
    const i = frames.findIndex((f) => f.t >= target);
    if (i < 0) return frames.at(-1)!; // Puffer leer gelaufen: letztes Bild halten
    if (i === 0) return frames[0]!;
    const a = frames[i - 1]!,
      b = frames[i]!;
    return mixFrames(a, b, (target - a.t) / (b.t - a.t || 1));
  }
}
