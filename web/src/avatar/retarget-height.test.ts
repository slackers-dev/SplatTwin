// Hoehe der Figur: in die Knie gehen, springen, Fuesse auf dem Boden.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import example from '../../../contracts/examples/run-smplx.json';
import type { RunSmplx } from '../contracts';
import { LM } from '../core/landmarks';
import type { Points } from './points';
import { Retargeter, twoBoneKnee } from './retarget';
import { buildSmplxSkeleton } from './smplx-avatar';

// SMPL-X als X wie bei ExAvatar: Beine weit gespreizt, Blick nach +z, links = +x.
const POSE: Record<number, [number, number, number]> = {
  0: [0, 1.0, 0], 1: [0.06, 0.9, 0], 2: [-0.06, 0.9, 0],
  3: [0, 1.1, 0], 6: [0, 1.25, 0], 9: [0, 1.35, 0], 12: [0, 1.55, 0], 15: [0, 1.65, 0],
  4: [0.3, 0.55, 0], 5: [-0.3, 0.55, 0], 7: [0.55, 0.2, 0], 8: [-0.55, 0.2, 0],
  10: [0.57, 0.12, 0.12], 11: [-0.57, 0.12, 0.12],
  13: [0.07, 1.45, 0], 14: [-0.07, 1.45, 0], 16: [0.18, 1.45, 0], 17: [-0.18, 1.45, 0],
  18: [0.4, 1.45, 0], 19: [-0.4, 1.45, 0], 20: [0.62, 1.45, 0], 21: [-0.62, 1.45, 0],
}; // prettier-ignore

function avatar() {
  const joints = (example as RunSmplx).joints.map((_, i) => POSE[i] ?? [0, 1, 0]);
  const { root, bones } = buildSmplxSkeleton({ ...(example as RunSmplx), joints: joints as RunSmplx['joints'] });
  root.updateMatrixWorld(true);
  const toeFloor = Math.min(POSE[10]![1], POSE[11]![1]);
  return { root, bones, r: new Retargeter(root), toeFloor };
}
const pos = (b: THREE.Bone) => b.getWorldPosition(new THREE.Vector3());
const none = (): Points => new Array(33).fill(null);
// Oberschenkel 0.424, Unterschenkel 0.430, Knoechel 0.08 ueber der Zehe: Hueftgelenk steht auf 0.93.
const LEG = Math.hypot(0.24, 0.35) + Math.hypot(0.25, 0.35);

describe('Hoehe der Figur', () => {
  it('steht aufrecht mit senkrechten Beinen und Fuessen auf dem Boden', () => {
    const { root, bones, r, toeFloor } = avatar();
    r.apply(none(), {}, { height: 0 });
    root.updateMatrixWorld(true);
    expect(pos(bones[1]!).y - toeFloor).toBeCloseTo(LEG + 0.08, 2);
    expect(Math.min(pos(bones[10]!).y, pos(bones[11]!).y)).toBeCloseTo(toeFloor, 2);
    const shin = pos(bones[7]!).sub(pos(bones[4]!)).normalize();
    expect(shin.y).toBeLessThan(-0.99);
  });

  it('geht in die Knie, ohne dass die Kamera die Beine sieht: Huefte tiefer, Fuesse am Boden, Knie vorne', () => {
    const { root, bones, r, toeFloor } = avatar();
    r.apply(none(), {}, { height: 0 });
    root.updateMatrixWorld(true);
    const standHip = pos(bones[0]!).y;
    r.apply(none(), {}, { height: -0.4 });
    root.updateMatrixWorld(true);
    expect(standHip - pos(bones[0]!).y).toBeCloseTo(0.37, 2); // 3 cm Totzone
    for (const [hip, knee, ankle, toe] of [[1, 4, 7, 10], [2, 5, 8, 11]] as const) {
      expect(pos(bones[toe]!).y).toBeCloseTo(toeFloor, 2);
      expect(pos(bones[hip]!).distanceTo(pos(bones[knee]!))).toBeCloseTo(Math.hypot(0.24, 0.35), 3);
      expect(pos(bones[knee]!).z).toBeGreaterThan(pos(bones[hip]!).z + 0.2); // Knie nach vorne
      expect(pos(bones[ankle]!).z).toBeCloseTo(pos(bones[hip]!).z, 2);
    }
  });

  it('springt: Beine gestreckt, Fuesse in der Luft', () => {
    const { root, bones, r, toeFloor } = avatar();
    r.apply(none(), {}, { height: 0.3 });
    root.updateMatrixWorld(true);
    expect(pos(bones[10]!).y - toeFloor).toBeCloseTo(0.24, 2); // 6 cm Totzone nach oben
    expect(pos(bones[7]!).sub(pos(bones[4]!)).normalize().y).toBeLessThan(-0.99);
  });

  it('kleines Rauschen der Hoehe bewegt die Figur nicht', () => {
    const { root, bones, r } = avatar();
    r.apply(none(), {}, { height: 0 });
    root.updateMatrixWorld(true);
    const y = pos(bones[0]!).y;
    for (const h of [-0.025, 0.05]) {
      r.apply(none(), {}, { height: h });
      root.updateMatrixWorld(true);
      expect(pos(bones[0]!).y).toBeCloseTo(y, 4);
    }
  });

  it('getrackte Beine geben die Richtung der Knie vor, der Boden haelt die Fuesse', () => {
    const { root, bones, r, toeFloor } = avatar();
    const P = none();
    // Hocke mit Knien nach aussen-vorne; die Messung sieht die Beine zu wenig gebeugt (zu lang nach unten).
    P[LM.lHip] = new THREE.Vector3(0.1, 0, 0);
    P[LM.rHip] = new THREE.Vector3(-0.1, 0, 0);
    P[LM.lSh] = new THREE.Vector3(0.18, 0.5, 0);
    P[LM.rSh] = new THREE.Vector3(-0.18, 0.5, 0);
    P[LM.lKn] = new THREE.Vector3(0.3, -0.25, 0.3);
    P[LM.rKn] = new THREE.Vector3(-0.3, -0.25, 0.3);
    P[LM.lAn] = new THREE.Vector3(0.2, -0.65, 0.1);
    P[LM.rAn] = new THREE.Vector3(-0.2, -0.65, 0.1);
    r.apply(P, {}, { height: -0.4 });
    root.updateMatrixWorld(true);
    expect(pos(bones[10]!).y).toBeCloseTo(toeFloor, 2);
    expect(pos(bones[11]!).y).toBeCloseTo(toeFloor, 2);
    expect(pos(bones[4]!).x).toBeGreaterThan(pos(bones[1]!).x + 0.1); // linkes Knie aussen
    expect(pos(bones[5]!).x).toBeLessThan(pos(bones[2]!).x - 0.1);
    expect(pos(bones[4]!).z).toBeGreaterThan(0.15);
  });

  it('ohne Hoehe wie bisher: tiefster Fuss auf dem Boden', () => {
    const { root, bones, r, toeFloor } = avatar();
    r.apply(none());
    root.updateMatrixWorld(true);
    expect(Math.min(pos(bones[10]!).y, pos(bones[11]!).y)).toBeCloseTo(toeFloor, 3);
  });

  it('gibt die Hoehe an Mitlaeufer weiter', () => {
    const leader = avatar(),
      follower = avatar();
    leader.r.followers.push(follower.r);
    leader.r.apply(none(), {}, { height: -0.4 });
    follower.root.updateMatrixWorld(true);
    expect(pos(follower.bones[4]!).z).toBeGreaterThan(0.2);
  });
});

describe('twoBoneKnee', () => {
  it('haelt beide Laengen und knickt Richtung pole', () => {
    const hip = new THREE.Vector3(0, 1, 0),
      ankle = new THREE.Vector3(0, 0.4, 0);
    const k = twoBoneKnee(hip, ankle, 0.5, 0.5, new THREE.Vector3(0, 0.7, 1), new THREE.Vector3(0, 0, 1));
    expect(k.distanceTo(hip)).toBeCloseTo(0.5, 6);
    expect(k.distanceTo(ankle)).toBeCloseTo(0.5, 6);
    expect(k.z).toBeCloseTo(0.4, 6);
  });
  it('streckt das Bein, wenn das Ziel zu weit weg ist', () => {
    const k = twoBoneKnee(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0), 0.4, 0.4, new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1));
    expect(k.y).toBeCloseTo(0.6, 3);
  });
});

describe('Kopf und Mund aus dem Gesichtsmodell', () => {
  const yaw = (deg: number): [number, number, number, number] => {
    const a = (deg * Math.PI) / 360;
    return [0, Math.sin(a), 0, Math.cos(a)];
  };

  it('dreht den Kopf wie das Gesicht', () => {
    const { root, bones, r } = avatar();
    r.apply(none(), {}, { face: { q: yaw(40), jaw: 0 } });
    root.updateMatrixWorld(true);
    // Blickrichtung des Kopfes: Ruhe (+z) um 40 Grad um y gedreht
    const q = bones[15]!.getWorldQuaternion(new THREE.Quaternion());
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    expect((Math.atan2(fwd.x, fwd.z) * 180) / Math.PI).toBeCloseTo(40, 1);
  });

  it('oeffnet den Kiefer: Kinn nach unten, auch bei gedrehtem Kopf', () => {
    // Kiefer mit Kinn vor und unter dem Gelenk, damit sich die Oeffnung messen laesst
    const { root, bones, r } = avatar();
    const chin = new THREE.Bone();
    chin.position.set(0, -0.08, 0.08);
    bones[22]!.add(chin);
    root.updateMatrixWorld(true);
    const chinAt = (jaw: number, turn: number) => {
      r.apply(none(), {}, { face: { q: yaw(turn), jaw } });
      root.updateMatrixWorld(true);
      return chin.getWorldPosition(new THREE.Vector3()).sub(bones[22]!.getWorldPosition(new THREE.Vector3()));
    };
    const closed = chinAt(0, 0),
      open = chinAt(1, 0);
    expect(open.y).toBeLessThan(closed.y - 0.015); // Kinn tiefer
    expect(open.z).toBeLessThan(closed.z); // und zurueck
    // Kopf 60 Grad gedreht: der Kiefer oeffnet sich trotzdem nach unten, nicht zur Seite
    const turned = chinAt(1, 60),
      turnedClosed = chinAt(0, 60);
    expect(turned.y).toBeLessThan(turnedClosed.y - 0.015);
    expect(turned.clone().sub(turnedClosed).length()).toBeCloseTo(open.clone().sub(closed).length(), 3);
  });
});
