import { describe, expect, it } from 'vitest';
import { type JointObservation, SkeletonEKF } from './ekf';
import { project, toB, yaw } from './testing';
import { IDENTITY, sub, type Vec2, type Vec3 } from './vec';

const R = yaw(-30);
const T: Vec3 = [1, 0, 0.2];
const params = { sigmaA: 2, sigmaZ: 0.01 };
const pos = (t: number): Vec3 => [0.3 * Math.sin(t / 800), -0.2, 3 + 0.2 * Math.cos(t / 800)];
/** Beobachtung nur fuer Gelenk 0. */
const obs = (n: Vec2): JointObservation[] => [{ n, vis: 1, mono: [0, 0, 0] }];

/** Ein Gelenk bewegt sich; beide Kameras sehen es abwechselnd und nie gleichzeitig. */
function track(ekf: SkeletonEKF, steps: number): number {
  let t = 0;
  for (let k = 0; k < steps; k++) {
    t += 33;
    if (k % 2 === 0) {
      const p = pos(t);
      ekf.updateCamera(t, obs(project(p)), IDENTITY, [0, 0, 0], { ...params, init: () => p });
    } else {
      ekf.updateCamera(t + 7, obs(project(toB(pos(t + 7), R, T))), R, T, params);
    }
  }
  return t;
}

describe('SkeletonEKF', () => {
  it('folgt einem Gelenk aus abwechselnden 2D-Messungen zweier Kameras', () => {
    const ekf = new SkeletonEKF(33);
    const t = track(ekf, 201);
    expect(Math.hypot(...sub(ekf.positions()[0]!, pos(t)))).toBeLessThan(0.02);
  });

  it('verwirft eine Messung, die nicht zur Vorhersage passt', () => {
    const ekf = new SkeletonEKF(33);
    const t = track(ekf, 201);
    const before = ekf.positions()[0]!;
    const n = project(toB(before, R, T));
    ekf.updateCamera(t + 1, obs([n[0] + 0.5, n[1]]), R, T, params);
    expect(ekf.rejected).toBe(1);
    expect(Math.hypot(...sub(ekf.positions()[0]!, before))).toBeLessThan(0.01);
  });

  it('vergisst ein Gelenk, das eine Sekunde lang nicht gesehen wurde', () => {
    const ekf = new SkeletonEKF(33);
    ekf.updateCamera(0, obs([0, 0]), IDENTITY, [0, 0, 0], { ...params, init: () => [0, 0, 3] });
    ekf.updateCamera(500, [], IDENTITY, [0, 0, 0], params);
    expect(ekf.positions()[0]).not.toBeNull();
    ekf.updateCamera(1500, [], IDENTITY, [0, 0, 0], params);
    expect(ekf.positions()[0]).toBeNull();
  });
});
