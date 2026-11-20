// Uebertraegt 3D-Landmarks (MediaPipe Pose, 33 Punkte) auf ein Mixamo-Skelett.
//
// Erwartet Punkte im three.js-Koordinatensystem: x = links der Person,
// y = oben, z = Richtung Betrachter. Fehlende Punkte duerfen null sein,
// der betroffene Koerperteil bleibt dann in der Ruhepose.

import * as THREE from 'three';

export const LM = {
  nose: 0, lEar: 7, rEar: 8,
  lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16,
  lHip: 23, rHip: 24, lKn: 25, rKn: 26, lAn: 27, rAn: 28, lToe: 31, rToe: 32,
};

// MediaPipe Hands: 0 = Handgelenk, danach je 4 Punkte pro Finger.
const FINGERS = [['Thumb', 1], ['Index', 5], ['Middle', 9], ['Ring', 13], ['Pinky', 17]];
const HAND = { wrist: 0, index: 5, pinky: 17 };

const HEAD_PITCH_OFFSET = 0.26; // Nase liegt tiefer als die Ohren (~15 Grad)

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _pq = new THREE.Quaternion();

// Orientierung aus "links"- und "oben"-Vektor (oben wird orthogonalisiert).
function basisQuat(left, up, out) {
  _x.copy(left).normalize();
  _z.crossVectors(_x, up).normalize();
  _y.crossVectors(_z, _x);
  return out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
}

// Orientierung der Handflaeche aus Handgelenk, Zeigefinger- und Kleinfinger-Knoechel.
function handBasis(wrist, index, pinky, out) {
  _v1.subVectors(index, wrist);
  _v2.subVectors(pinky, wrist);
  _z.crossVectors(_v1, _v2).normalize();
  _x.addVectors(_v1, _v2).normalize();
  _y.crossVectors(_z, _x);
  return out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
}

function mid(a, b, out) {
  return out.addVectors(a, b).multiplyScalar(0.5);
}

export class Retargeter {
  constructor(model) {
    this.model = model;
    this.bones = {};
    model.traverse((o) => {
      if (o.isBone) this.bones[o.name.replace(/^mixamorig:?/, '')] = o;
    });
    const need = ['Hips', 'Spine', 'Neck', 'Head', 'LeftArm', 'LeftForeArm', 'LeftHand',
      'RightArm', 'RightForeArm', 'RightHand', 'LeftUpLeg', 'LeftLeg', 'LeftFoot',
      'RightUpLeg', 'RightLeg', 'RightFoot'];
    const missing = need.filter((n) => !this.bones[n]);
    if (missing.length) throw new Error('Knochen fehlen im Modell: ' + missing.join(', '));

    model.updateMatrixWorld(true);
    this.rest = new Map();
    for (const bone of Object.values(this.bones)) {
      this.rest.set(bone, {
        local: bone.quaternion.clone(),
        world: bone.getWorldQuaternion(new THREE.Quaternion()),
      });
    }

    // Ausrichtung des Modells in der Ruhepose (egal in welche Richtung es schaut).
    const b = this.bones;
    const left = this.#pos(b.LeftUpLeg, new THREE.Vector3()).sub(this.#pos(b.RightUpLeg, _v1));
    const up = this.#pos(b.Neck, new THREE.Vector3()).sub(this.#pos(b.Hips, _v1));
    this.restBasisInv = basisQuat(left, up, new THREE.Quaternion()).invert();

    // Haende: Ruhe-Orientierung der Handflaeche, falls das Modell Fingerknochen hat.
    this.hands = {};
    for (const side of ['Left', 'Right']) {
      const hand = b[side + 'Hand'], index = b[side + 'HandIndex1'], pinky = b[side + 'HandPinky1'];
      if (!index || !pinky) continue;
      const q = handBasis(this.#pos(hand, new THREE.Vector3()), this.#pos(index, new THREE.Vector3()),
        this.#pos(pinky, new THREE.Vector3()), new THREE.Quaternion());
      this.hands[side] = { hand, restBasisInv: q.invert() };
    }

    this.footBones = [b.LeftToeBase || b.LeftFoot, b.RightToeBase || b.RightFoot];
    this.restFootY = this.#lowestFoot();
  }

  #pos(bone, out) {
    return bone.getWorldPosition(out);
  }

  #lowestFoot() {
    let y = Infinity;
    for (const f of this.footBones) y = Math.min(y, this.#pos(f, _v1).y);
    return y - this.model.position.y;
  }

  // Setzt die Welt-Orientierung eines Knochens relativ zur Ruhepose.
  #orient(bone, targetBasis) {
    const rest = this.rest.get(bone);
    _q.copy(targetBasis).multiply(this.restBasisInv).multiply(rest.world);
    bone.parent.getWorldQuaternion(_pq).invert();
    bone.quaternion.copy(_pq).multiply(_q);
  }

  // Dreht einen Knochen so, dass er von "from" nach "to" zeigt.
  #aim(bone, child, from, to) {
    if (!bone || !child || !from || !to) return;
    const cur = this.#pos(child, _v1).sub(this.#pos(bone, _v2)).normalize();
    const tgt = _v2.subVectors(to, from);
    if (tgt.lengthSq() < 1e-8) return;
    _q.setFromUnitVectors(cur, tgt.normalize());
    bone.parent.getWorldQuaternion(_pq);
    // lokal = parent^-1 * q * parent * lokal
    bone.quaternion.premultiply(_pq).premultiply(_q).premultiply(_pq.invert());
  }

  // P: 33 Koerperpunkte. hands: { Left, Right } mit je 21 Handpunkten oder null.
  apply(P, hands = {}) {
    const b = this.bones;
    for (const [bone, rest] of this.rest) bone.quaternion.copy(rest.local);

    const lSh = P[LM.lSh], rSh = P[LM.rSh], lHip = P[LM.lHip], rHip = P[LM.rHip];
    const basis = new THREE.Quaternion();
    const left = new THREE.Vector3();
    const up = new THREE.Vector3();
    const a = new THREE.Vector3();
    const c = new THREE.Vector3();

    if (lSh && rSh && lHip && rHip) {
      up.subVectors(mid(lSh, rSh, a), mid(lHip, rHip, c));
      // Becken folgt der Hueftlinie, Oberkoerper der Schulterlinie.
      this.#orient(b.Hips, basisQuat(left.subVectors(lHip, rHip), up, basis));
      this.#orient(b.Spine, basisQuat(left.subVectors(lSh, rSh), up, basis));
    } else if (lSh && rSh) {
      // Nur Oberkoerper sichtbar (z.B. am Schreibtisch): Rumpf bleibt aufrecht.
      up.set(0, 1, 0);
      this.#orient(b.Spine, basisQuat(left.subVectors(lSh, rSh), up, basis));
    }

    const nose = P[LM.nose], lEar = P[LM.lEar], rEar = P[LM.rEar];
    if (nose && lEar && rEar) {
      left.subVectors(lEar, rEar).normalize();
      const fwd = a.subVectors(nose, mid(lEar, rEar, c)).applyAxisAngle(left, -HEAD_PITCH_OFFSET);
      up.crossVectors(fwd, left);
      this.#orient(b.Head, basisQuat(left, up, basis));
    }

    this.#aim(b.LeftArm, b.LeftForeArm, lSh, P[LM.lEl]);
    this.#aim(b.LeftForeArm, b.LeftHand, P[LM.lEl], P[LM.lWr]);
    this.#aim(b.RightArm, b.RightForeArm, rSh, P[LM.rEl]);
    this.#aim(b.RightForeArm, b.RightHand, P[LM.rEl], P[LM.rWr]);

    this.#aim(b.LeftUpLeg, b.LeftLeg, lHip, P[LM.lKn]);
    this.#aim(b.LeftLeg, b.LeftFoot, P[LM.lKn], P[LM.lAn]);
    this.#aim(b.LeftFoot, b.LeftToeBase, P[LM.lAn], P[LM.lToe]);
    this.#aim(b.RightUpLeg, b.RightLeg, rHip, P[LM.rKn]);
    this.#aim(b.RightLeg, b.RightFoot, P[LM.rKn], P[LM.rAn]);
    this.#aim(b.RightFoot, b.RightToeBase, P[LM.rAn], P[LM.rToe]);

    for (const side of ['Left', 'Right']) {
      const H = hands[side];
      const rig = this.hands[side];
      if (!H || !rig) continue;
      handBasis(H[HAND.wrist], H[HAND.index], H[HAND.pinky], basis);
      _q.copy(basis).multiply(rig.restBasisInv).multiply(this.rest.get(rig.hand).world);
      rig.hand.parent.getWorldQuaternion(_pq).invert();
      rig.hand.quaternion.copy(_pq).multiply(_q);
      for (const [name, i0] of FINGERS) {
        for (let k = 0; k < 3; k++) {
          const bone = b[`${side}Hand${name}${k + 1}`];
          this.#aim(bone, b[`${side}Hand${name}${k + 2}`], H[i0 + k], H[i0 + k + 1]);
        }
      }
    }

    // Tiefster Fuss bleibt auf dem Boden.
    this.model.position.y = this.restFootY - this.#lowestFoot();
  }
}
