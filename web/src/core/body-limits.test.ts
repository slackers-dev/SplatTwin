import { describe, expect, it } from 'vitest';
import { limitBody, limitKnee, type LimitReport } from './body-limits';
import { LM } from './landmarks';
import { norm, sub, type Vec3 } from './vec';

function body(): (Vec3 | null)[] {
  const P: (Vec3 | null)[] = new Array(33).fill(null);
  P[LM.lSh] = [0.18, 0.5, 0];
  P[LM.rSh] = [-0.18, 0.5, 0];
  P[LM.lHip] = [0.1, 0, 0];
  P[LM.rHip] = [-0.1, 0, 0];
  P[LM.lEar] = [0.07, 0.75, 0];
  P[LM.rEar] = [-0.07, 0.75, 0];
  return P;
}

describe('Koerpergrenzen', () => {
  it('schiebt eine Hand aus dem Bauch an die Oberflaeche', () => {
    const P = body();
    P[LM.lWr] = [0.02, 0.2, 0.03]; // im Rumpf
    const r: LimitReport = { pushed: 0, knees: 0 };
    const out = limitBody(P, r)!;
    expect(r.pushed).toBe(1);
    expect(out[LM.lWr]![2]).toBeGreaterThan(0.1); // vor dem Bauch
    expect(P[LM.lWr]![2]).toBe(0.03); // Eingabe unveraendert
  });

  it('laesst Haende neben dem Koerper in Ruhe', () => {
    const P = body();
    P[LM.lWr] = [0.3, 0.1, 0];
    expect(limitBody(P)![LM.lWr]).toEqual([0.3, 0.1, 0]);
  });

  it('haelt eine Hand am Kopf ausserhalb des Kopfes', () => {
    const P = body();
    P[LM.lWr] = [0.03, 0.8, 0];
    const out = limitBody(P)!;
    expect(norm(sub(out[LM.lWr]!, [0, 0.75, 0]))).toBeGreaterThan(0.11);
  });

  it('laesst das Knie nicht nach vorne durchknicken, beugen geht', () => {
    const left: Vec3 = [1, 0, 0];
    const H: Vec3 = [0, 0, 0],
      K: Vec3 = [0, -0.45, 0];
    // Unterschenkel 30 Grad nach vorne: unmoeglich
    const bad = limitKnee(H, K, [0, -0.45 - 0.4 * Math.cos(0.52), 0.4 * Math.sin(0.52)], left)!;
    expect(bad[2]).toBeLessThan(0.4 * Math.sin(0.15));
    expect(norm(sub(bad, K))).toBeCloseTo(0.4, 6);
    // 30 Grad nach hinten: normales Beugen
    expect(limitKnee(H, K, [0, -0.45 - 0.4 * Math.cos(0.52), -0.4 * Math.sin(0.52)], left)).toBeNull();
  });
});
