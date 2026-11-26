// Uebertraegt 3D-Landmarks (MediaPipe Pose, 33 Punkte) auf ein Mixamo-Skelett.
//
// Erwartet Punkte im three.js-Koordinatensystem: x = links der Person,
// y = oben, z = Richtung Betrachter. Fehlende Punkte duerfen null sein,
// der betroffene Koerperteil bleibt dann in der Ruhepose.
import * as THREE from 'three';
import { LM } from '../core/landmarks';
import type { HandPoints, Points } from './points';

// MediaPipe Hands: 0 = Handgelenk, danach je 4 Punkte pro Finger.
const FINGERS: [string, number][] = [['Thumb', 1], ['Index', 5], ['Middle', 9], ['Ring', 13], ['Pinky', 17]];
const HAND = { wrist: 0, index: 5, pinky: 17 };
const SIDES = ['Left', 'Right'] as const;

// Knochen, die im Modus "nur Oberkoerper" in einer festen Haltung bleiben.
const LOWER_BODY = ['Hips', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase'];
const REQUIRED = ['Hips', 'Spine', 'Neck', 'Head', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm',
  'RightHand', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'] as const;

const HEAD_PITCH_OFFSET = 0.26; // Nase liegt tiefer als die Ohren (~15 Grad)

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _pq = new THREE.Quaternion();

type Vec = THREE.Vector3 | null | undefined;

/** Orientierung aus "links"- und "oben"-Vektor (oben wird orthogonalisiert). */
function basisQuat(left: THREE.Vector3, up: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  _x.copy(left).normalize();
  _z.crossVectors(_x, up).normalize();
  _y.crossVectors(_z, _x);
  return out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
}

/** Orientierung der Handflaeche aus Handgelenk, Zeigefinger- und Kleinfinger-Knoechel. */
function handBasis(wrist: THREE.Vector3, index: THREE.Vector3, pinky: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  _v1.subVectors(index, wrist);
  _v2.subVectors(pinky, wrist);
  _z.crossVectors(_v1, _v2).normalize();
  _x.addVectors(_v1, _v2).normalize();
  _y.crossVectors(_z, _x);
  return out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
}

function mid(a: THREE.Vector3, b: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  return out.addVectors(a, b).multiplyScalar(0.5);
}

export type Bones = Record<string, THREE.Bone | undefined> & Record<(typeof REQUIRED)[number], THREE.Bone>;

export class Retargeter {
  readonly model: THREE.Object3D;
  readonly bones: Bones;
  /** Nur Oberkoerper: Huefte und Beine werden nicht getrackt, sondern bleiben in lowerPose. */
  upperBodyOnly = false;
  /** Weitere Skelette, die bei jedem apply dieselben Punkte bekommen (z. B. SMPL-X unter einem Splat). */
  readonly followers: Retargeter[] = [];
  private lowerPose: [THREE.Bone, THREE.Quaternion][] | null = null;
  private readonly rest = new Map<THREE.Bone, { local: THREE.Quaternion; world: THREE.Quaternion }>();
  private readonly restBasisInv: THREE.Quaternion;
  private readonly hands: Partial<Record<(typeof SIDES)[number], { hand: THREE.Bone; restBasisInv: THREE.Quaternion }>> = {};
  private readonly footBones: THREE.Bone[];
  private readonly restFootY: number;

  constructor(model: THREE.Object3D) {
    this.model = model;
    const bones: Record<string, THREE.Bone> = {};
    model.traverse((o) => {
      if ((o as THREE.Bone).isBone) bones[o.name.replace(/^mixamorig:?/, '')] = o as THREE.Bone;
    });
    const missing = REQUIRED.filter((n) => !bones[n]);
    if (missing.length) throw new Error('Knochen fehlen im Modell: ' + missing.join(', '));
    this.bones = bones as Bones;
    const b = this.bones;

    model.updateMatrixWorld(true);
    for (const bone of Object.values(bones)) {
      this.rest.set(bone, { local: bone.quaternion.clone(), world: bone.getWorldQuaternion(new THREE.Quaternion()) });
    }

    // Ausrichtung des Modells in der Ruhepose (egal in welche Richtung es schaut).
    const left = this.pos(b.LeftUpLeg, new THREE.Vector3()).sub(this.pos(b.RightUpLeg, _v1));
    const up = this.pos(b.Neck, new THREE.Vector3()).sub(this.pos(b.Hips, _v1));
    this.restBasisInv = basisQuat(left, up, new THREE.Quaternion()).invert();

    // Haende: Ruhe-Orientierung der Handflaeche, falls das Modell Fingerknochen hat.
    for (const side of SIDES) {
      const hand = b[`${side}Hand`],
        index = b[`${side}HandIndex1`],
        pinky = b[`${side}HandPinky1`];
      if (!hand || !index || !pinky) continue;
      const q = handBasis(this.pos(hand, new THREE.Vector3()), this.pos(index, new THREE.Vector3()),
        this.pos(pinky, new THREE.Vector3()), new THREE.Quaternion());
      this.hands[side] = { hand, restBasisInv: q.invert() };
    }

    this.footBones = [b.LeftToeBase ?? b.LeftFoot, b.RightToeBase ?? b.RightFoot];
    this.restFootY = this.lowestFoot();
  }

  private pos(bone: THREE.Bone, out: THREE.Vector3): THREE.Vector3 {
    return bone.getWorldPosition(out);
  }

  private lowestFoot(): number {
    let y = Infinity;
    for (const f of this.footBones) y = Math.min(y, this.pos(f, _v1).y);
    return y - this.model.position.y;
  }

  /** Setzt die Welt-Orientierung eines Knochens relativ zur Ruhepose. */
  private orient(bone: THREE.Bone, targetBasis: THREE.Quaternion): void {
    const rest = this.rest.get(bone)!;
    _q.copy(targetBasis).multiply(this.restBasisInv).multiply(rest.world);
    bone.parent!.getWorldQuaternion(_pq).invert();
    bone.quaternion.copy(_pq).multiply(_q);
  }

  /** Dreht einen Knochen so, dass er von "from" nach "to" zeigt. */
  private aim(bone: THREE.Bone | undefined, child: THREE.Bone | undefined, from: Vec, to: Vec): void {
    if (!bone || !child || !from || !to) return;
    const cur = this.pos(child, _v1).sub(this.pos(bone, _v2)).normalize();
    const tgt = _v2.subVectors(to, from);
    if (tgt.lengthSq() < 1e-8) return;
    _q.setFromUnitVectors(cur, tgt.normalize());
    bone.parent!.getWorldQuaternion(_pq);
    // lokal = parent^-1 * q * parent * lokal
    bone.quaternion.premultiply(_pq).premultiply(_q).premultiply(_pq.invert());
  }

  private aimLegs(P: Points, lHip: Vec, rHip: Vec): void {
    const b = this.bones;
    this.aim(b.LeftUpLeg, b.LeftLeg, lHip, P[LM.lKn]);
    this.aim(b.LeftLeg, b.LeftFoot, P[LM.lKn], P[LM.lAn]);
    this.aim(b.LeftFoot, b.LeftToeBase, P[LM.lAn], P[LM.lToe]);
    this.aim(b.RightUpLeg, b.RightLeg, rHip, P[LM.rKn]);
    this.aim(b.RightLeg, b.RightFoot, P[LM.rKn], P[LM.rAn]);
    this.aim(b.RightFoot, b.RightToeBase, P[LM.rAn], P[LM.rToe]);
  }

  /** Merkt sich die aktuelle Haltung von Huefte und Beinen fuer den Modus "nur Oberkoerper". */
  holdLowerBody(): void {
    this.lowerPose = LOWER_BODY.flatMap((n) => {
      const bone = this.bones[n];
      return bone ? [[bone, bone.quaternion.clone()] as [THREE.Bone, THREE.Quaternion]] : [];
    });
  }

  /** P: 33 Koerperpunkte. hands: je 21 Handpunkte oder null. */
  apply(P: Points, hands: HandPoints = {}): void {
    const b = this.bones;
    for (const [bone, rest] of this.rest) bone.quaternion.copy(rest.local);
    const upper = this.upperBodyOnly;
    if (upper && this.lowerPose) for (const [bone, q] of this.lowerPose) bone.quaternion.copy(q);

    const lSh = P[LM.lSh],
      rSh = P[LM.rSh];
    const lHip = upper ? null : P[LM.lHip],
      rHip = upper ? null : P[LM.rHip];
    const basis = new THREE.Quaternion();
    const left = new THREE.Vector3();
    const up = new THREE.Vector3();
    const a = new THREE.Vector3();
    const c = new THREE.Vector3();

    if (lSh && rSh && lHip && rHip) {
      up.subVectors(mid(lSh, rSh, a), mid(lHip, rHip, c));
      // Becken folgt der Hueftlinie, Oberkoerper der Schulterlinie.
      this.orient(b.Hips, basisQuat(left.subVectors(lHip, rHip), up, basis));
      this.orient(b.Spine, basisQuat(left.subVectors(lSh, rSh), up, basis));
    } else if (lSh && rSh) {
      // Nur Oberkoerper sichtbar (z.B. am Schreibtisch): Rumpf bleibt aufrecht.
      up.set(0, 1, 0);
      this.orient(b.Spine, basisQuat(left.subVectors(lSh, rSh), up, basis));
    }

    const nose = P[LM.nose],
      lEar = P[LM.lEar],
      rEar = P[LM.rEar];
    if (nose && lEar && rEar) {
      left.subVectors(lEar, rEar).normalize();
      const fwd = a.subVectors(nose, mid(lEar, rEar, c)).applyAxisAngle(left, -HEAD_PITCH_OFFSET);
      up.crossVectors(fwd, left);
      this.orient(b.Head, basisQuat(left, up, basis));
    }

    this.aim(b.LeftArm, b.LeftForeArm, lSh, P[LM.lEl]);
    this.aim(b.LeftForeArm, b.LeftHand, P[LM.lEl], P[LM.lWr]);
    this.aim(b.RightArm, b.RightForeArm, rSh, P[LM.rEl]);
    this.aim(b.RightForeArm, b.RightHand, P[LM.rEl], P[LM.rWr]);

    if (!upper) this.aimLegs(P, lHip, rHip);

    for (const side of SIDES) {
      const H = hands[side];
      const rig = this.hands[side];
      const wrist = H?.[HAND.wrist],
        index = H?.[HAND.index],
        pinky = H?.[HAND.pinky];
      if (!H || !rig || !wrist || !index || !pinky) continue;
      handBasis(wrist, index, pinky, basis);
      _q.copy(basis).multiply(rig.restBasisInv).multiply(this.rest.get(rig.hand)!.world);
      rig.hand.parent!.getWorldQuaternion(_pq).invert();
      rig.hand.quaternion.copy(_pq).multiply(_q);
      for (const [name, i0] of FINGERS) {
        for (let k = 0; k < 3; k++) {
          this.aim(b[`${side}Hand${name}${k + 1}`], b[`${side}Hand${name}${k + 2}`], H[i0 + k], H[i0 + k + 1]);
        }
      }
    }

    // Tiefster Fuss bleibt auf dem Boden.
    this.model.position.y = this.restFootY - this.lowestFoot();

    for (const f of this.followers) {
      f.upperBodyOnly = upper;
      f.apply(P, hands);
    }
  }
}
