import { describe, expect, it } from 'vitest';
import {
  baselineFor,
  depthFromDisparity,
  depthSigmaParallel,
  rectify,
  rectifyPoint,
  triangulationPrecision,
  unrectifyPoint,
} from './rectify';
import { project, random, toB, yaw } from './testing';
import { mulMM, type Vec3 } from './vec';

const tilt = (deg: number) => {
  const a = (deg * Math.PI) / 180;
  return [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)] as const;
};

describe('rectify', () => {
  // Kamera B steht 40 cm rechts, ist 35 Grad eingedreht und etwas geneigt: nicht parallel.
  const R = mulMM([...tilt(4)], yaw(-35));
  const T: Vec3 = [-0.4, 0.03, 0.08];
  const rect = rectify({ R, T });

  it('legt gleiche Punkte auf dieselbe Zeile und findet die Tiefe aus der Disparitaet', () => {
    const rnd = random(5);
    for (let k = 0; k < 50; k++) {
      const X: Vec3 = [(rnd() - 0.5) * 1.5, (rnd() - 0.5) * 1.5, 2 + rnd() * 2];
      const a = rectifyPoint(project(X), rect.RA)!;
      const b = rectifyPoint(project(toB(X, R, T)), rect.RB)!;
      expect(a[1]).toBeCloseTo(b[1], 9); // gleiche Zeile
      const Z = depthFromDisparity(a[0], b[0], rect.baseline)!;
      // Tiefe im rektifizierten System = Abstand von der Basislinie entlang der neuen z-Achse
      const zRect = rect.RA[6] * X[0] + rect.RA[7] * X[1] + rect.RA[8] * X[2];
      expect(Z).toBeCloseTo(zRect, 9);
    }
  });

  it('meldet Winkel und Abstand des Aufbaus', () => {
    expect(rect.vergence).toBeGreaterThan(34);
    expect(rect.vergence).toBeLessThan(36);
    expect(Math.abs(rect.baseline)).toBeCloseTo(Math.hypot(...T), 9);
    expect(rect.conditioning).toBeGreaterThan(40);
  });

  it('bleibt aufrecht, wenn Kamera B links steht', () => {
    const left = rectify({ R: yaw(20), T: [0.5, 0, 0] });
    expect(left.baseline).toBeLessThan(0);
    expect(left.RA[0]).toBeGreaterThan(0.8); // x zeigt weiter nach rechts
    const X: Vec3 = [0.1, 0.2, 3];
    const a = rectifyPoint(project(X), left.RA)!;
    const b = rectifyPoint(project(toB(X, yaw(20), [0.5, 0, 0])), left.RB)!;
    expect(depthFromDisparity(a[0], b[0], left.baseline)).toBeGreaterThan(0);
  });

  it('rechnet Punkte hin und zurueck', () => {
    const n: [number, number] = [0.21, -0.13];
    const back = unrectifyPoint(rectifyPoint(n, rect.RB)!, rect.RB)!;
    expect(back[0]).toBeCloseTo(n[0], 12);
    expect(back[1]).toBeCloseTo(n[1], 12);
  });

  it('erkennt hintereinander stehende Kameras', () => {
    expect(rectify({ R: yaw(0), T: [0, 0, -1] }).conditioning).toBeLessThan(1);
  });
});

describe('Genauigkeit', () => {
  it('stimmt bei parallelen Kameras mit der Lehrbuchformel ueberein', () => {
    const b = 0.3,
      Z = 3,
      sigma = 2 / 900; // 2 px bei 900 px Brennweite
    const p = triangulationPrecision([0, 0, Z], { R: yaw(0), T: [-b, 0, 0] }, sigma)!;
    // Disparitaet aus zwei Bildpunkten: sigmaD = sqrt(2) sigma
    expect(p.depth).toBeCloseTo(depthSigmaParallel(Z, b, Math.SQRT2 * sigma), 3);
    expect(p.lateral).toBeLessThan(p.depth / 5);
    expect(baselineFor(Z, p.depth, Math.SQRT2 * sigma)).toBeCloseTo(b, 2);
  });

  it('wird mit groesserem Winkel zwischen den Sehstrahlen besser', () => {
    const sigma = 3 / 900;
    const X: Vec3 = [0, 0, 3];
    // Kamera B auf einem Kreis um die Person, jeweils auf sie gerichtet
    const at = (deg: number) => {
      const a = (deg * Math.PI) / 180;
      const R = yaw(deg);
      const c: Vec3 = [3 * Math.sin(a), 0, 3 - 3 * Math.cos(a)]; // Zentrum von B in A
      const T = [-(R[0] * c[0] + R[1] * c[1] + R[2] * c[2]), -(R[3] * c[0] + R[4] * c[1] + R[5] * c[2]), -(R[6] * c[0] + R[7] * c[1] + R[8] * c[2])] as Vec3;
      return triangulationPrecision(X, { R, T }, sigma)!;
    };
    const p10 = at(10),
      p30 = at(30),
      p90 = at(90);
    expect(p10.rayAngle).toBeCloseTo(10, 6);
    expect(p30.depth).toBeLessThan(p10.depth / 2.5);
    expect(p90.depth).toBeLessThan(p30.depth);
    expect(p90.worst).toBeLessThan(p10.worst / 3);
  });
});
