import { describe, expect, it } from 'vitest';
import { OneEuroGroup, OneEuroPoint, smoothingParams } from './one-euro';
import { random } from './testing';
import type { Vec3 } from './vec';

const DT = 1 / 30;
const spread = (xs: number[]) => {
  const m = xs.reduce((s, v) => s + v, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / xs.length);
};

describe('One-Euro-Filter', () => {
  it('nimmt einem ruhenden Punkt das Zittern', () => {
    const rnd = random(2);
    const f = new OneEuroPoint();
    const params = smoothingParams(0.6)!;
    const raw: number[] = [],
      out: number[] = [];
    for (let k = 0; k < 300; k++) {
      const x = (rnd() - 0.5) * 0.04; // +-2 cm Zittern
      raw.push(x);
      out.push(f.step([x, 0, 0], DT, params)![0]);
    }
    expect(spread(out.slice(50))).toBeLessThan(spread(raw) / 3);
  });

  it('folgt einer schnellen Bewegung mit wenig Verzoegerung', () => {
    const f = new OneEuroPoint();
    const params = smoothingParams(0.6)!;
    let p: Vec3 | null = null;
    // 2 m/s, eine Sekunde lang
    for (let k = 0; k <= 30; k++) p = f.step([2 * k * DT, 0, 0], DT, params);
    expect(2 - p![0]).toBeLessThan(0.15); // weniger als 15 cm hinterher
  });

  it('staerkere Glaettung ist ruhiger', () => {
    const a = smoothingParams(0.2)!,
      b = smoothingParams(0.9)!;
    expect(b.minCutoff).toBeLessThan(a.minCutoff);
    expect(smoothingParams(0)).toBeNull();
  });

  it('Gruppe reicht Luecken durch und setzt einzelne Punkte zurueck', () => {
    const g = new OneEuroGroup(2);
    const params = smoothingParams(0.5);
    g.step([[0, 0, 0], [1, 1, 1]], DT, params);
    const out = g.step([[0.01, 0, 0], null], DT, params)!;
    expect(out[1]).toBeNull();
    expect(out[0]![0]).toBeGreaterThan(0);
    expect(out[0]![0]).toBeLessThan(0.01);
  });
});
