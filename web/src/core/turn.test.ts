import { describe, expect, it } from 'vitest';
import { TurnCounter, wrapDegrees } from './turn';

describe('turn', () => {
  it('wrapDegrees bleibt zwischen -180 und 180', () => {
    expect(wrapDegrees(190)).toBe(-170);
    expect(wrapDegrees(-190)).toBe(170);
    expect(wrapDegrees(10)).toBe(10);
  });

  it('zaehlt eine ganze Drehung in 20 s', () => {
    const c = new TurnCounter(0, 0);
    for (let t = 33; t <= 20000; t += 33) c.update(wrapDegrees((t / 20000) * 360), t);
    expect(c.fraction).toBeGreaterThan(0.99);
    expect(c.speed).toBeCloseTo(18, 0);
  });

  it('ignoriert Spruenge durch vertauschte Schultern', () => {
    const c = new TurnCounter(0, 0);
    c.update(10, 100);
    c.update(-170, 200); // Sprung um 180 Grad
    c.update(-160, 300);
    expect(c.turned).toBe(20);
  });

  it('ueberspringt Bilder ohne Person', () => {
    const c = new TurnCounter(0, 0);
    c.update(null, 100);
    c.update(30, 200);
    expect(c.turned).toBe(30);
  });
});
