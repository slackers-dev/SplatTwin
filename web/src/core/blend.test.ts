import { describe, expect, it } from 'vitest';
import type { LiveFrame } from '../contracts';
import { FrameBlend, mixPoint } from './blend';

const frame = (t: number, x: number): LiveFrame => ({
  t,
  upper: false,
  mirror: false,
  pos: [x, 0],
  pts: [[x, 1, 0], null],
  hands: { Left: null, Right: null },
});

describe('Ueberblendung zwischen Live-Bildern', () => {
  it('mischt Punkte und nimmt den neueren, wenn einer fehlt', () => {
    expect(mixPoint([0, 0, 0], [2, 4, -2], 0.5)).toEqual([1, 2, -1]);
    expect(mixPoint(null, [2, 4, -2], 0.5)).toEqual([2, 4, -2]);
    expect(mixPoint([1, 1, 1], null, 0.5)).toBeNull();
  });

  it('laeuft ueber die Zeit zwischen zwei Bildern beim Sender', () => {
    const b = new FrameBlend();
    expect(b.sample(0)).toBeNull();
    b.receive(frame(1000, 0), 0);
    expect(b.sample(5)!.pos[0]).toBe(0); // erstes Bild sofort
    b.receive(frame(1100, 1), 100); // 100 ms spaeter gesendet
    expect(b.sample(100)!.pos[0]).toBeCloseTo(0);
    expect(b.sample(150)!.pts[0]![0]).toBeCloseTo(0.5);
    expect(b.sample(250)!.pos[0]).toBeCloseTo(1);
  });

  it('springt nicht, wenn ein neues Bild mitten in der Ueberblendung kommt', () => {
    const b = new FrameBlend();
    b.receive(frame(0, 0), 0);
    b.sample(0);
    b.receive(frame(100, 1), 100);
    const mid = b.sample(150)!.pos[0]!; // 0.5
    b.receive(frame(200, 2), 150);
    expect(b.sample(150)!.pos[0]).toBeCloseTo(mid);
    expect(b.sample(250)!.pos[0]).toBeCloseTo(2);
  });
});
