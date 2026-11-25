import { describe, expect, it } from 'vitest';
import { KalmanPoint } from './kalman';

describe('KalmanPoint', () => {
  it('liefert null, solange nie gemessen wurde', () => {
    expect(new KalmanPoint().step(null, 1 / 30, 8, 0.02)).toBeNull();
  });

  it('folgt einer gleichfoermigen Bewegung ohne bleibenden Rueckstand', () => {
    const f = new KalmanPoint();
    let p = null;
    for (let k = 0; k <= 90; k++) p = f.step([k / 30, 1, 0], 1 / 30, 8, 0.02);
    expect(p?.[0]).toBeCloseTo(3, 2);
    expect(f.v[0]).toBeCloseTo(1, 1);
  });

  it('glaettet Rauschen', () => {
    const f = new KalmanPoint();
    let worst = 0;
    for (let k = 0; k < 200; k++) {
      const noise = k % 2 ? 0.02 : -0.02;
      const p = f.step([0, noise, 0], 1 / 30, 1, 0.02);
      if (k > 50) worst = Math.max(worst, Math.abs(p?.[1] ?? 1));
    }
    expect(worst).toBeLessThan(0.01);
  });

  it('sagt ohne Messung voraus und bremst dabei ab', () => {
    const f = new KalmanPoint();
    for (let k = 0; k <= 30; k++) f.step([k / 30, 0, 0], 1 / 30, 8, 0.02);
    const before = f.v[0];
    const p = f.step(null, 1 / 30, 8, 0.02);
    expect(p?.[0]).toBeGreaterThan(1);
    expect(f.v[0]).toBeCloseTo(before * 0.85, 5);
  });

  it('startet nach reset neu bei der naechsten Messung', () => {
    const f = new KalmanPoint();
    f.step([1, 1, 1], 1 / 30, 8, 0.02);
    f.reset();
    expect(f.step([5, 5, 5], 1 / 30, 8, 0.02)).toEqual([5, 5, 5]);
  });
});
