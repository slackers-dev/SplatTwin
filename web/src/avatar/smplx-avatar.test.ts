import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import example from '../../../contracts/examples/run-smplx.json';
import type { RunSmplx } from '../contracts';
import { LM } from '../core/landmarks';
import type { Points } from './points';
import { Retargeter } from './retarget';
import { buildSmplxSkeleton, SMPLX_BONES } from './smplx-avatar';

// Grobe SMPL-X-Haltung wie im PLY von LHM++: Arme 30 Grad nach unten, Blick nach +z, links = +x.
const POSE: Record<number, [number, number, number]> = {
  0: [0, 1.0, 0], // Becken
  1: [0.06, 0.9, 0], 2: [-0.06, 0.9, 0], // Hueften
  3: [0, 1.1, 0], 6: [0, 1.25, 0], 9: [0, 1.35, 0], 12: [0, 1.55, 0], 15: [0, 1.65, 0], // Wirbelsaeule, Kopf
  4: [0.1, 0.5, 0], 5: [-0.1, 0.5, 0], 7: [0.12, 0.1, 0], 8: [-0.12, 0.1, 0], // Knie, Knoechel
  10: [0.12, 0.02, 0.1], 11: [-0.12, 0.02, 0.1], // Fuesse
  13: [0.07, 1.45, 0], 14: [-0.07, 1.45, 0], // Schluesselbeine
  16: [0.18, 1.45, 0], 17: [-0.18, 1.45, 0], // Schultern
  18: [0.4, 1.32, 0], 19: [-0.4, 1.32, 0], // Ellbogen
  20: [0.62, 1.2, 0], 21: [-0.62, 1.2, 0], // Handgelenke
}; // prettier-ignore

function meta(): RunSmplx {
  const joints = (example as RunSmplx).joints.map((_, i) => POSE[i] ?? [0, 1, 0]);
  return { ...(example as RunSmplx), joints: joints as RunSmplx['joints'] };
}

const pos = (b: THREE.Bone) => b.getWorldPosition(new THREE.Vector3());

describe('SMPL-X-Skelett', () => {
  it('hat alle Knochen, die der Retargeter braucht, an den Gelenken aus smplx.json', () => {
    const m = meta();
    const { root, bones } = buildSmplxSkeleton(m);
    expect(bones).toHaveLength(55);
    expect(SMPLX_BONES).toHaveLength(55);
    root.updateMatrixWorld(true);
    expect(pos(bones[20]!).toArray()).toEqual(m.joints[20]);
    expect(bones[18]!.parent).toBe(bones[16]);
    expect(() => new Retargeter(root)).not.toThrow();
  });

  it('dreht den Arm in die getrackte Richtung und laesst Mitlaeufer mitgehen', () => {
    const { root, bones } = buildSmplxSkeleton(meta());
    root.updateMatrixWorld(true);
    const leader = new Retargeter(root.clone(true));
    const follower = new Retargeter(root);
    leader.followers.push(follower);
    // Linker Arm gerade nach oben, alles andere fehlt (bleibt in Ruhe).
    const P: Points = new Array(33).fill(null);
    P[LM.lSh] = new THREE.Vector3(0.18, 1.45, 0);
    P[LM.lEl] = new THREE.Vector3(0.18, 1.75, 0);
    P[LM.lWr] = new THREE.Vector3(0.18, 2.05, 0);
    leader.apply(P);
    root.updateMatrixWorld(true);
    const upper = pos(bones[18]!).sub(pos(bones[16]!)).normalize();
    const fore = pos(bones[20]!).sub(pos(bones[18]!)).normalize();
    expect(upper.y).toBeGreaterThan(0.99);
    expect(fore.y).toBeGreaterThan(0.99);
  });
});
