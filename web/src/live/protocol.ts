// Binaerformat fuer ein Bild des Live-Trackings (contracts/live-frame beschreibt das entpackte Bild).
//
//   u8  Version (2)
//   u8  Flags: 1 = nur Oberkoerper, 2 = gespiegelt, 4 = linke Hand dabei, 8 = rechte Hand dabei,
//       16 = Gesicht dabei
//   u32 Zeit beim Sender in ms (performance.now, fuer die Interpolation)
//   i16 x, i16 z  Position am Boden in mm
//   i16 Hoehe der Huefte relativ zum Stehen in mm (-32768 = unbekannt)
//   u32 Maske: welche der 17 Koerpergelenke (BODY) vorhanden sind
//   je vorhandenes Gelenk 3 x i16 in 0,1 mm (reicht fuer +-3,2 m um die Huefte)
//   je vorhandene Hand 21 x 3 x i16 in 0,1 mm
//   Gesicht (falls dabei): Kopfdrehung 4 x i16 (Quaternion x 32767), u8 Mund offen (x 255)
// Little Endian. Etwa 120 Bytes ohne, 370 Bytes mit beiden Haenden (JSON war 1 bis 2,3 KB).
// Der Server prueft nur die Laenge (server/stage.py: frame_ok) und stellt fuer die Zuschauer ein Byte
// mit dem Platz davor (0 = A, 1 = B).
import type { LiveFrame } from '../contracts';
import type { Hands } from '../core/hands';
import type { FacePose } from '../core/face';
import type { Vec3 } from '../core/vec';

/** Nur diese MediaPipe-Punkte braucht der Retargeter: Nase, Ohren, Arme, Beine, Zehen. */
export const BODY = [0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 31, 32] as const;
export const SLOTS = ['A', 'B'] as const;
export type Slot = (typeof SLOTS)[number];

const VERSION = 2;
const HEADER = 16;
const NO_HEIGHT = -32768;
const SCALE = 10000; // 0,1 mm
const HAND_POINTS = 21;
const FACE_BYTES = 9;

const int16 = (v: number) => Math.max(-32767, Math.min(32767, Math.round(v)));

export interface FrameInput {
  t: number;
  upper: boolean;
  mirror: boolean;
  /** Position am Boden [x, z] in Metern */
  pos: [number, number];
  /** Hoehe der Huefte relativ zum Stehen in Metern, null = unbekannt */
  height: number | null;
  /** 33 Gelenke, null = unbekannt */
  pts: readonly (Vec3 | null)[];
  hands: Hands<readonly (Vec3 | null)[]>;
  /** Kopf und Mund (core/face), null ohne Gesicht */
  face: FacePose | null;
}

/** Hand nur, wenn alle 21 Punkte da sind (sonst fehlt sie fuer den Avatar ohnehin). */
const fullHand = (h: readonly (Vec3 | null)[] | null | undefined): Vec3[] | null =>
  h && h.length === HAND_POINTS && h.every((p) => p !== null) ? (h as Vec3[]) : null;

export function encodeFrame(f: FrameInput): ArrayBuffer {
  const body = BODY.map((i) => f.pts[i] ?? null);
  const left = fullHand(f.hands.Left),
    right = fullHand(f.hands.Right);
  const count = body.filter((p) => p !== null).length;
  const face = f.face && f.face.q.every(Number.isFinite) ? f.face : null;
  const buf = new ArrayBuffer(HEADER + count * 6 + ((left ? 1 : 0) + (right ? 1 : 0)) * HAND_POINTS * 6 + (face ? FACE_BYTES : 0));
  const v = new DataView(buf);
  v.setUint8(0, VERSION);
  v.setUint8(1, (f.upper ? 1 : 0) | (f.mirror ? 2 : 0) | (left ? 4 : 0) | (right ? 8 : 0) | (face ? 16 : 0));
  v.setUint32(2, Math.round(f.t) >>> 0, true);
  v.setInt16(6, int16(f.pos[0] * 1000), true);
  v.setInt16(8, int16(f.pos[1] * 1000), true);
  v.setInt16(10, f.height === null || !Number.isFinite(f.height) ? NO_HEIGHT : int16(f.height * 1000), true);
  let mask = 0,
    o = HEADER;
  const put = (p: Vec3) => {
    for (let k = 0; k < 3; k++) v.setInt16(o + 2 * k, int16(p[k]! * SCALE), true);
    o += 6;
  };
  body.forEach((p, k) => {
    if (p) {
      mask |= 1 << k;
      put(p);
    }
  });
  v.setUint32(12, mask >>> 0, true);
  for (const h of [left, right]) h?.forEach(put);
  if (face) {
    face.q.forEach((x, k) => v.setInt16(o + 2 * k, int16(x * 32767), true));
    v.setUint8(o + 8, Math.round(Math.max(0, Math.min(1, face.jaw)) * 255));
  }
  return buf;
}

/** Gegenstueck zu encodeFrame; offset ueberspringt z. B. das Byte mit dem Platz. */
export function decodeFrame(buf: ArrayBuffer, offset = 0): LiveFrame {
  const v = new DataView(buf, offset);
  if (v.getUint8(0) !== VERSION) throw new Error('unbekannte Version des Bildformats');
  const flags = v.getUint8(1);
  const mask = v.getUint32(12, true);
  const height = v.getInt16(10, true);
  let o = HEADER;
  const get = (): Vec3 => {
    const p: Vec3 = [v.getInt16(o, true) / SCALE, v.getInt16(o + 2, true) / SCALE, v.getInt16(o + 4, true) / SCALE];
    o += 6;
    return p;
  };
  const pts: (Vec3 | null)[] = new Array(33).fill(null);
  BODY.forEach((i, k) => {
    if (mask & (1 << k)) pts[i] = get();
  });
  const hand = (on: number) => (on ? Array.from({ length: HAND_POINTS }, get) : null);
  const Left = hand(flags & 4),
    Right = hand(flags & 8);
  const face: FacePose | null =
    flags & 16
      ? { q: [0, 1, 2, 3].map((k) => v.getInt16(o + 2 * k, true) / 32767) as FacePose['q'], jaw: v.getUint8(o + 8) / 255 }
      : null;
  return {
    t: v.getUint32(2, true),
    upper: !!(flags & 1),
    mirror: !!(flags & 2),
    pos: [v.getInt16(6, true) / 1000, v.getInt16(8, true) / 1000],
    height: height === NO_HEIGHT ? null : height / 1000,
    pts,
    hands: { Left, Right },
    face,
  };
}
