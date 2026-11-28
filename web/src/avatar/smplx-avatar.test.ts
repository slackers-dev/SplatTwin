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

  // ExAvatar steht als X: Knie und Knoechel weit aussen.
  function xPose() {
    const m = meta();
    const j = m.joints.map((p) => [...p]) as RunSmplx['joints'];
    j[4] = [0.47, 0.35, 0]; j[5] = [-0.45, 0.33, 0]; j[7] = [0.82, 0.06, 0]; j[8] = [-0.83, 0.06, 0];
    j[10] = [0.89, 0.06, 0.05]; j[11] = [-0.88, 0.05, 0.05];
    const { root, bones } = buildSmplxSkeleton({ ...m, joints: j });
    root.updateMatrixWorld(true);
    return { root, bones, r: new Retargeter(root) };
  } // prettier-ignore
  const dir = (bones: THREE.Bone[], a: number, b: number) => pos(bones[b]!).sub(pos(bones[a]!)).normalize();

  it('laesst ungesehene Beine gerade haengen statt gespreizt wie in der Aufnahme', () => {
    const { root, bones, r } = xPose();
    const toeBefore = dir(bones, 7, 10);
    r.apply(new Array(33).fill(null));
    root.updateMatrixWorld(true);
    for (const [hip, knee, ankle] of [[1, 4, 7], [2, 5, 8]] as const) {
      expect(dir(bones, hip, knee).y).toBeLessThan(-0.99);
      expect(dir(bones, knee, ankle).y).toBeLessThan(-0.99);
    }
    // Fuss bleibt flach und zeigt wie vorher nach vorne
    expect(dir(bones, 7, 10).dot(toeBefore)).toBeGreaterThan(0.99);
  });

  it('folgt getrackten Beinen auch aus der X-Haltung', () => {
    const { root, bones, r } = xPose();
    const P: Points = new Array(33).fill(null);
    P[LM.lHip] = new THREE.Vector3(0.1, 0.9, 0);
    P[LM.rHip] = new THREE.Vector3(-0.1, 0.9, 0);
    P[LM.lKn] = new THREE.Vector3(0.1, 0.6, 0.3); // Knie nach vorne gehoben
    P[LM.lAn] = new THREE.Vector3(0.1, 0.2, 0.3);
    r.apply(P);
    root.updateMatrixWorld(true);
    const thigh = dir(bones, 1, 4);
    expect(thigh.z).toBeGreaterThan(0.6);
    expect(Math.abs(thigh.x)).toBeLessThan(0.05);
    expect(dir(bones, 4, 7).y).toBeLessThan(-0.99);
    expect(dir(bones, 2, 5).y).toBeLessThan(-0.99); // rechtes Bein fehlt: gerade
  });

  it('haelt die Beine im Modus nur Oberkoerper ohne festgehaltene Haltung gerade', () => {
    const { root, bones, r } = xPose();
    r.upperBodyOnly = true;
    r.apply(new Array(33).fill(null));
    root.updateMatrixWorld(true);
    expect(dir(bones, 1, 4).y).toBeLessThan(-0.99);
  });
});
