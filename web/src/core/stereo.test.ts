import { describe, expect, it } from 'vitest';
import { type CalibrationFrame, calibrate, hornRotation, rodrigues, triangulate, undistort } from './stereo';
import { project, random, skeleton, toB, yaw } from './testing';
import { add, mulMM, mulMV, sub, type Vec3 } from './vec';

const R = yaw(-35);
const T: Vec3 = [1.1, 0.05, 0.3];

describe('stereo', () => {
  it('trianguliert einen Punkt exakt', () => {
    const X: Vec3 = [0.2, -0.3, 2.5];
    const got = triangulate(project(X), project(toB(X, R, T)), R, T)!;
    got.forEach((v, i) => expect(v).toBeCloseTo(X[i], 9));
  });

  it('liefert null fuer Punkte hinter einer Kamera', () => {
    const X: Vec3 = [0.2, -0.3, -2.5];
    expect(triangulate(project(X), project(toB(X, R, T)), R, T)).toBeNull();
  });

  it('macht die Verzeichnung rueckgaengig', () => {
    const dist = [0.1, -0.2, 0.001, -0.002, 0.05];
    const [x, y] = [0.3, -0.2];
    const r2 = x * x + y * y;
    const radial = 1 + dist[0] * r2 + dist[1] * r2 * r2 + dist[4] * r2 ** 3;
    const xd = x * radial + 2 * dist[2] * x * y + dist[3] * (r2 + 2 * x * x);
    const yd = y * radial + dist[2] * (r2 + 2 * y * y) + 2 * dist[3] * x * y;
    const [ux, uy] = undistort(xd, yd, dist);
    expect(ux).toBeCloseTo(x, 8);
    expect(uy).toBeCloseTo(y, 8);
  });

  it('Rodrigues ergibt eine Drehung', () => {
    const Q = rodrigues([0.3, -0.2, 0.5]);
    const QtQ = mulMM([Q[0], Q[3], Q[6], Q[1], Q[4], Q[7], Q[2], Q[5], Q[8]], Q);
    QtQ.forEach((v, i) => expect(v).toBeCloseTo([1, 0, 0, 0, 1, 0, 0, 0, 1][i], 12));
  });

  it('Horn findet die Drehung zwischen zwei Punktwolken', () => {
    const a = skeleton();
    const got = hornRotation(a, a.map((p) => mulMV(R, p)));
    got.forEach((v, i) => expect(v).toBeCloseTo(R[i], 6));
  });

  it('kalibriert zwei Kameras aus den Gelenken einer Person', () => {
    const rnd = random(3);
    const body = skeleton();
    const frames: CalibrationFrame[] = [];
    for (let k = 0; k < 40; k++) {
      // Person geht vor Kamera A umher und dreht sich etwas.
      const hip: Vec3 = [(rnd() - 0.5) * 1.2, (rnd() - 0.5) * 0.3, 3 + rnd() * 1.5];
      const turn = yaw((rnd() - 0.5) * 60);
      const joints = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
      const WA = joints.map((i) => mulMV(turn, body[i]));
      const XA = WA.map((w) => add(hip, w));
      frames.push({
        nA: XA.map(project),
        nB: XA.map((X) => project(toB(X, R, T))),
        WA,
        WB: WA.map((w) => mulMV(R, w)),
      });
    }
    const c = calibrate(frames);
    c.R.forEach((v, i) => expect(v).toBeCloseTo(R[i], 3));
    expect(c.baseline).toBeCloseTo(Math.hypot(...T), 2);
    expect(Math.hypot(...sub(c.T, T))).toBeLessThan(0.02);
    expect(c.rms).toBeLessThan(1e-4);
  });

  it('lehnt zu wenige Aufnahmen ab', () => {
    expect(() => calibrate([])).toThrow(/Zu wenige/);
  });
});
