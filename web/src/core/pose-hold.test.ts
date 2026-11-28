import { describe, expect, it } from 'vitest';
import { LM } from './landmarks';
import { PoseHold } from './pose-hold';
import type { Vec3 } from './vec';

/** Stehende Person, Blick zur Kamera (x links der Person, y oben, z nach vorne). */
function body(): (Vec3 | null)[] {
  const P: (Vec3 | null)[] = new Array(33).fill(null);
  P[LM.lSh] = [0.18, 0.5, 0];
  P[LM.rSh] = [-0.18, 0.5, 0];
  P[LM.lHip] = [0.1, 0, 0];
  P[LM.rHip] = [-0.1, 0, 0];
  P[LM.lEl] = [0.2, 0.2, 0];
  P[LM.lWr] = [0.2, -0.05, 0.1];
  return P;
}

/** Dreht alle Punkte um die senkrechte Achse. */
const turn = (P: (Vec3 | null)[], a: number) =>
  P.map((p) => (p ? ([p[0] * Math.cos(a) + p[2] * Math.sin(a), p[1], -p[0] * Math.sin(a) + p[2] * Math.cos(a)] as Vec3) : null));

describe('Einfrieren verlorener Gelenke', () => {
  it('haelt ein verlorenes Handgelenk an seiner Stelle am Ellbogen', () => {
    const h = new PoseHold();
    h.step(body(), 1 / 30);
    const P = body();
    P[LM.lWr] = null;
    P[LM.lEl] = [0.25, 0.2, 0]; // Ellbogen bewegt sich 5 cm
    const out = h.step(P, 1 / 30)!;
    expect(out[LM.lWr]![0]).toBeCloseTo(0.25, 5);
    expect(out[LM.lWr]![2]).toBeCloseTo(0.1, 5);
  });

  it('dreht eingefrorene Glieder mit dem Rumpf mit', () => {
    const h = new PoseHold();
    h.step(body(), 1 / 30);
    const P = turn(body(), Math.PI / 2);
    P[LM.lWr] = null;
    P[LM.lEl] = null;
    const out = h.step(P, 1 / 30)!;
    const want = turn(body(), Math.PI / 2)[LM.lWr]!;
    for (let k = 0; k < 3; k++) expect(out[LM.lWr]![k]).toBeCloseTo(want[k]!, 5);
  });

  it('gibt nach der Haltezeit auf', () => {
    const h = new PoseHold(1);
    h.step(body(), 1 / 30);
    const P = body();
    P[LM.lWr] = null;
    let out: (Vec3 | null)[] | null = null;
    for (let k = 0; k < 40; k++) out = h.step(P, 1 / 30);
    expect(out![LM.lWr]).toBeNull();
  });

  it('haelt eine verlorene Hand am Handgelenk', () => {
    const h = new PoseHold();
    const hand: Vec3[] = Array.from({ length: 21 }, (_, i) => [0, -0.01 * i, 0]);
    h.stepHand('Left', hand, [0, 0, 0], 1 / 30);
    const held = h.stepHand('Left', null, [0.1, 0, 0], 1 / 30)!;
    expect(held[0]).toEqual([0.1, 0, 0]);
    expect(held[20]![1]).toBeCloseTo(-0.2, 6);
  });
});
