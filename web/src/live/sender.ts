// Schickt pro Bild, was der Avatar bekommt, an den Server; Zuschauerseiten bauen daraus denselben
// Avatar nach. Nur Punkte, kein Bild: ein paar Kilobyte pro Bild.
import type { LiveFrame, Point } from '../contracts';
import type { Hands } from '../core/hands';
import type { Vec3 } from '../core/vec';

const round = (p: Vec3 | null | undefined): Point => (p ? [+p[0].toFixed(4), +p[1].toFixed(4), +p[2].toFixed(4)] : null);

export interface LiveState {
  run: string;
  upper: boolean;
  mirror: boolean;
  /** Position des Avatars am Boden [x, z] */
  pos: [number, number];
  pts: (Vec3 | null)[];
  hands: Hands<Vec3[]>;
}

export function liveFrame(s: LiveState): LiveFrame {
  return {
    t: Math.round(performance.now()),
    run: s.run,
    upper: s.upper,
    mirror: s.mirror,
    pos: [+s.pos[0].toFixed(4), +s.pos[1].toFixed(4)],
    pts: s.pts.map(round),
    hands: { Left: s.hands.Left?.map(round) ?? null, Right: s.hands.Right?.map(round) ?? null },
  };
}

export interface LiveInfo {
  lan: boolean;
  /** Adressen fuer Geraete im WLAN, leer ohne --lan */
  urls: string[];
  viewers: number;
}

export const fetchLiveInfo = async (): Promise<LiveInfo> => (await fetch('/api/info')).json() as Promise<LiveInfo>;

export class LiveSender {
  private busy = false;

  /** Sendet, falls der Server mit dem letzten Bild fertig ist (sonst wird dieses ausgelassen). */
  send(frame: LiveFrame, onResult: (viewers: number | null) => void): void {
    if (this.busy) return;
    this.busy = true;
    fetch('/api/live', { method: 'POST', body: JSON.stringify(frame) })
      .then((r) => r.json() as Promise<{ viewers: number }>)
      .then((r) => onResult(r.viewers))
      .catch(() => onResult(null))
      .finally(() => {
        this.busy = false;
      });
  }
}
