// Bewegungsbegrenzer: kein Knochen dreht sich schneller oder ruckartiger, als ein Koerper kann.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import example from '../../../contracts/examples/run-smplx.json';
import type { RunSmplx } from '../contracts';
import { LM } from '../core/landmarks';
import type { Points } from './points';
import { Retargeter } from './retarget';
import { buildSmplxSkeleton } from './smplx-avatar';

// Grobe SMPL-X-Haltung: Arme leicht nach unten, Blick nach +z, links = +x.
const POSE: Record<number, [number, number, number]> = {
  0: [0, 1.0, 0], 1: [0.06, 0.9, 0], 2: [-0.06, 0.9, 0],
  3: [0, 1.1, 0], 6: [0, 1.25, 0], 9: [0, 1.35, 0], 12: [0, 1.55, 0], 15: [0, 1.65, 0],
  4: [0.1, 0.5, 0], 5: [-0.1, 0.5, 0], 7: [0.12, 0.1, 0], 8: [-0.12, 0.1, 0],
  10: [0.12, 0.02, 0.1], 11: [-0.12, 0.02, 0.1],
  13: [0.07, 1.45, 0], 14: [-0.07, 1.45, 0], 16: [0.18, 1.45, 0], 17: [-0.18, 1.45, 0],
  18: [0.4, 1.32, 0], 19: [-0.4, 1.32, 0], 20: [0.62, 1.2, 0], 21: [-0.62, 1.2, 0],
}; // prettier-ignore

function avatar() {
  const joints = (example as RunSmplx).joints.map((_, i) => POSE[i] ?? [0, 1, 0]);
  const { root, bones } = buildSmplxSkeleton({ ...(example as RunSmplx), joints: joints as RunSmplx['joints'] });
  root.updateMatrixWorld(true);
  return { root, bones, r: new Retargeter(root) };
}

/** Linker Arm haengt (down) oder zeigt nach oben (up). */
function pose(arm: 'down' | 'up'): Points {
  const P: Points = new Array(33).fill(null);
  P[LM.lSh] = new THREE.Vector3(0.18, 1.4, 0);
  P[LM.rSh] = new THREE.Vector3(-0.18, 1.4, 0);
  P[LM.lHip] = new THREE.Vector3(0.1, 0.9, 0);
  P[LM.rHip] = new THREE.Vector3(-0.1, 0.9, 0);
  P[LM.lEl] = arm === 'down' ? new THREE.Vector3(0.2, 1.1, 0) : new THREE.Vector3(0.18, 1.7, 0);
  P[LM.lWr] = arm === 'down' ? new THREE.Vector3(0.2, 0.85, 0) : new THREE.Vector3(0.18, 1.95, 0);
  return P;
}

const upperArm = (bones: THREE.Bone[]) => {
  // SMPL-X: 16 linke Schulter, 18 linker Ellbogen
  const a = bones[16]!.getWorldPosition(new THREE.Vector3());
  return bones[18]!.getWorldPosition(new THREE.Vector3()).sub(a).normalize();
};

describe('Bewegungsbegrenzer', () => {
  it('macht aus einem Sprung eine kurze, weiche Bewegung', () => {
    const { root, bones, r } = avatar();
    const dt = 1 / 30;
    r.apply(pose('down'), {}, { dt });
    root.updateMatrixWorld(true);
    const before = upperArm(bones);
    r.apply(pose('up'), {}, { dt }); // Arm springt in einem Bild 180 Grad
    root.updateMatrixWorld(true);
    const first = upperArm(bones);
    expect(before.angleTo(first)).toBeLessThan(0.2); // erstes Bild: nur anlaufen
    for (let k = 0; k < 30; k++) r.apply(pose('up'), {}, { dt });
    root.updateMatrixWorld(true);
    expect(upperArm(bones).y).toBeGreaterThan(0.99); // nach einer Sekunde angekommen
  });

  it('ohne dt gilt jede Haltung sofort', () => {
    const { root, bones, r } = avatar();
    r.apply(pose('down'));
    r.apply(pose('up'));
    root.updateMatrixWorld(true);
    expect(upperArm(bones).y).toBeGreaterThan(0.99);
  });
});
