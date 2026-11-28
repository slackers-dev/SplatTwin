import { describe, expect, it } from 'vitest';
import type { LiveFrame } from '../contracts';
import { FrameBlend, mixFrames, mixPoint } from './blend';

const frame = (t: number, x: number): LiveFrame => ({
  t,
  upper: false,
  mirror: false,
  pos: [x, 0],
  height: -x,
  pts: [[x, 1, 0], null],
  hands: { Left: null, Right: null },
  face: null,
});

describe('Ueberblendung zwischen Live-Bildern', () => {
  it('mischt Punkte und nimmt den neueren, wenn einer fehlt', () => {
    expect(mixPoint([0, 0, 0], [2, 4, -2], 0.5)).toEqual([1, 2, -1]);
    expect(mixPoint(null, [2, 4, -2], 0.5)).toEqual([2, 4, -2]);
    expect(mixPoint([1, 1, 1], null, 0.5)).toBeNull();
  });

  it('spielt im Takt des Senders ab, mit kurzer Verzoegerung', () => {
    const b = new FrameBlend();
    expect(b.sample(0)).toBeNull();
    // 20 Bilder/s, x waechst um 1 pro Bild; Ankunft ohne Laufzeitschwankung
    for (let k = 0; k <= 10; k++) b.receive(frame(1000 + k * 50, k), k * 50);
    const d = b.delay;
    expect(d).toBeGreaterThanOrEqual(60);
    // Abspielzeit = jetzt - Verzoegerung: zwischen zwei Bildern gemischt
    expect(b.sample(500)!.pos[0]).toBeCloseTo((500 - d) / 50);
    expect(b.sample(475)!.pts[0]![0]).toBeCloseTo((475 - d) / 50);
  });

  it('bleibt gleichmaessig, wenn die Bilder unregelmaessig ankommen', () => {
    const b = new FrameBlend();
    // gesendet alle 50 ms, angekommen mit 0 bis 80 ms Verspaetung (Bilder kommen paarweise)
    const lag = [0, 80, 0, 70, 10, 80, 0, 60, 0, 80, 0, 75, 5, 80, 0, 70, 0, 80, 0, 80, 0];
    const xs: number[] = [];
    let k = 0;
    for (let now = 0; now <= 1000; now += 10) {
      while (k < lag.length && k * 50 + lag[k]! <= now) {
        b.receive(frame(k * 50, k), k * 50 + lag[k]!);
        k++;
      }
      if (now >= 300) xs.push(b.sample(now)!.pos[0]!);
    }
    // gleich grosse Schritte: jede 10 ms um 0.2 (= 1 pro 50 ms), kein Ruckeln
    const steps = xs.slice(1).map((x, i) => x - xs[i]!);
    for (const s of steps) expect(s).toBeCloseTo(0.2, 5);
  });

  it('haelt das letzte Bild, wenn nichts mehr kommt, und beginnt neu, wenn der Sender neu startet', () => {
    const b = new FrameBlend();
    b.receive(frame(5000, 1), 0);
    b.receive(frame(5050, 2), 50);
    expect(b.sample(2000)!.pos[0]).toBe(2);
    b.receive(frame(10, 7), 2100); // neue Tracking-Seite, Zeit von vorn
    expect(b.sample(2100)!.pos[0]).toBe(7);
  });

  it('blendet nicht ueber, wenn links und rechts vertauscht sind (Avatar kippte sonst)', () => {
    const torso = (sign: number): LiveFrame => {
      const f = frame(0, 0);
      const pts: LiveFrame['pts'] = new Array(33).fill(null);
      pts[11] = [0.18 * sign, 0.5, 0];
      pts[12] = [-0.18 * sign, 0.5, 0];
      pts[23] = [0.1 * sign, 0, 0];
      pts[24] = [-0.1 * sign, 0, 0];
      return { ...f, pts };
    };
    const mid = mixFrames(torso(1), torso(-1), 0.5);
    expect(mid.pts[11]).toEqual([-0.18, 0.5, 0]); // direkt das neue Bild, keine Schultern auf einem Punkt
    // kleine Bewegung wird weiter uebergeblendet
    const a = torso(1),
      b = { ...torso(1), pts: torso(1).pts.map((p) => (p ? ([p[0] + 0.04, p[1], p[2]] as [number, number, number]) : null)) };
    expect(mixFrames(a, b, 0.5).pts[11]![0]).toBeCloseTo(0.2);
  });
});
