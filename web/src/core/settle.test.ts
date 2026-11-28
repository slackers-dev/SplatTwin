import { describe, expect, it } from 'vitest';
import { Settle } from './settle';
import type { Vec3 } from './vec';

describe('Settle', () => {
  it('ignoriert die unruhigen ersten Bilder und liefert dann das Mittel', () => {
    const s = new Settle(4, 0.1);
    const seq: Vec3[] = [[0, 0, -15], [0.5, 0, -8], [0, 0, -3], [0.02, 0, -3.02], [0, 0, -3], [0.02, 0, -2.98]];
    const out = seq.map((p) => s.step(p));
    expect(out.slice(0, 5).every((p) => p === null)).toBe(true);
    expect(out[5]![0]).toBeCloseTo(0.01);
    expect(out[5]![2]).toBeCloseTo(-3);
  });
});
