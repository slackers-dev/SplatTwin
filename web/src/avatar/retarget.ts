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
const DOWN = new THREE.Vector3(0, -1, 0);

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

/**
 * Knie fuer ein Bein von hip nach ankle mit Oberschenkel a und Unterschenkel b (Kosinussatz). Das Knie
 * knickt Richtung pole; liegt pole auf der Linie, Richtung fallback. Zu weit: Bein gestreckt.
 */
export function twoBoneKnee(
  hip: THREE.Vector3,
  ankle: THREE.Vector3,
  a: number,
  b: number,
  pole: THREE.Vector3,
  fallback: THREE.Vector3,
): THREE.Vector3 {
  const axis = new THREE.Vector3().subVectors(ankle, hip);
  const dist = THREE.MathUtils.clamp(axis.length(), Math.abs(a - b) + 1e-4, a + b - 1e-6);
  if (axis.lengthSq() < 1e-10) axis.set(0, -1, 0);
  axis.normalize();
  const along = (a * a - b * b + dist * dist) / (2 * dist);
  const side = Math.sqrt(Math.max(0, a * a - along * along));
  const bend = new THREE.Vector3().subVectors(pole, hip);
  bend.addScaledVector(axis, -bend.dot(axis));
  if (bend.lengthSq() < 1e-8) bend.copy(fallback).addScaledVector(axis, -fallback.dot(axis));
  if (bend.lengthSq() < 1e-8) bend.set(0, 0, 1);
  return hip.clone().addScaledVector(axis, along).addScaledVector(bend.normalize(), side);
}

interface LegRig {
  side: (typeof SIDES)[number];
  up: THREE.Bone;
  leg: THREE.Bone;
  foot: THREE.Bone;
  toe: THREE.Bone | undefined;
  thigh: number;
  shin: number;
  ankle: number;
}

/** Was apply ausser den Punkten bekommen kann. */
export interface ApplyOptions {
  /**
   * Hoehe der Huefte relativ zum aufrechten Stehen in Metern (core/height): negativ in der Hocke,
   * positiv im Sprung. Dann steht die Figur auf dieser Hoehe, und die Beine knicken so ein, dass die
   * Fuesse auf dem Boden bleiben (auch wenn die Kamera die Beine nicht sieht). null: wie bisher
   * bleibt der tiefste Fuss auf dem Boden.
   */
  height?: number | null;
  /**
   * Zeit seit dem letzten apply in Sekunden. Dann dreht sich kein Knochen schneller und ruckartiger,
   * als es ein Koerper kann (siehe MAX_TURN_SPEED): Ausreisser und Spruenge werden zu einer kurzen,
   * weichen Bewegung. Ohne dt: jede Haltung sofort.
   */
  dt?: number;
  /**
   * Kopf und Mund aus dem Gesichtsmodell (core/face): Drehung des Kopfes, Blick in die Kamera = keine
   * Drehung, und Mund offen 0..1. Dann folgt der Kopf dieser Drehung statt Nase und Ohren, und ein
   * Kiefergelenk (SMPL-X: Jaw) oeffnet sich mit. null: Kopf aus Nase und Ohren wie bisher.
   */
  face?: { q: [number, number, number, number]; jaw: number } | null;
}

// Kiefer: jawOpen von MediaPipe liegt beim Sprechen meist bei 0.2 bis 0.5, darum verstaerkt (JAW_GAIN).
// Ganz offen 16 Grad: beim Splat von ExAvatar sah mehr unnatuerlich aus (Mundinnenraum zu gross).
const JAW_MAX = 0.28; // rad
const JAW_GAIN = 1.6;

// Grenzen fuer die Drehung eines Knochens. Schnelle Armbewegungen erreichen etwa 700 Grad/s, eine
// Messung, die von einem Bild zum naechsten um 90 Grad springt, waere 2700 Grad/s.
const MAX_TURN_SPEED = 12; // rad/s
const MAX_TURN_ACCEL = 150; // rad/s^2: von Ruhe auf volle Geschwindigkeit in 0,08 s

// So wenig Unterschied gilt noch als Stehen (Rauschen der Messung). Nach oben mehr: Schwebende Fuesse
// fallen staerker auf als leicht gebeugte Knie, und ein echter Sprung ist hoeher.
const DEADZONE_DOWN = 0.03; // m
const DEADZONE_UP = 0.06; // m
const MAX_JUMP = 0.5; // m
const MIN_HIP = 0.3; // tiefste Huefte als Anteil der Beinlaenge (ganz unten in der Hocke)
const FLOOR_EPS = 0.01; // m: naeher am Boden gilt der Fuss als aufgesetzt

export type Bones = Record<string, THREE.Bone | undefined> & Record<(typeof REQUIRED)[number], THREE.Bone>;

export class Retargeter {
  readonly model: THREE.Object3D;
  readonly bones: Bones;
  /** Nur Oberkoerper: Huefte und Beine werden nicht getrackt, sondern bleiben in lowerPose. */
  upperBodyOnly = false;
  /** Weitere Skelette, die bei jedem apply dieselben Punkte bekommen (z. B. SMPL-X unter einem Splat). */
  readonly followers: Retargeter[] = [];
  private lowerPose: [THREE.Bone, THREE.Quaternion][] | null = null;
  /** Letzte gezeigte Drehung und Drehschritt pro Knochen (Bewegungsbegrenzer). */
  private readonly motion = new Map<THREE.Bone, { q: THREE.Quaternion; step: number }>();
  private readonly rest = new Map<THREE.Bone, { local: THREE.Quaternion; world: THREE.Quaternion }>();
  private readonly restBasisInv: THREE.Quaternion;
  private readonly hands: Partial<Record<(typeof SIDES)[number], { hand: THREE.Bone; restBasisInv: THREE.Quaternion }>> = {};
  private readonly footBones: THREE.Bone[];
  private readonly restFootY: number;
  /** Beine fuer die Hoehe: Laengen und Hoehe des Knoechels ueber dem Boden in der Ruhehaltung. */
  private readonly legs: LegRig[] = [];
  private readonly restForward = new THREE.Vector3();
  private readonly restLeft = new THREE.Vector3();
  /** Hoehe der Hueftgelenke ueber dem Boden beim aufrechten Stehen (Beine gestreckt nach unten). */
  private readonly standHipY: number;

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

    _z.crossVectors(left, up);
    this.restForward.copy(_z).normalize();
    this.restLeft.copy(left).normalize();
    for (const side of SIDES) {
      const up = b[`${side}UpLeg`],
        leg = b[`${side}Leg`],
        foot = b[`${side}Foot`],
        toe = b[`${side}ToeBase`];
      const H = this.pos(up, new THREE.Vector3()),
        K = this.pos(leg, new THREE.Vector3()),
        A = this.pos(foot, new THREE.Vector3());
      // Knoechel ueber dem Boden, wenn der Fuss flach steht: so hoch wie ueber der Zehe in der Ruhehaltung.
      const ankle = toe ? Math.max(0, A.y - this.pos(toe, _v1).y) : 0;
      this.legs.push({ side, up, leg, foot, toe, thigh: H.distanceTo(K), shin: K.distanceTo(A), ankle });
    }
    this.standHipY = Math.min(...this.legs.map((l) => l.thigh + l.shin + l.ankle));
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

  /** Dreht einen Knochen so, dass er in Richtung dir (Welt) zeigt. */
  private aimDir(bone: THREE.Bone | undefined, child: THREE.Bone | undefined, dir: THREE.Vector3): void {
    if (!bone || !child) return;
    const from = this.pos(bone, new THREE.Vector3());
    this.aim(bone, child, from, from.clone().add(dir));
  }

  /**
   * Beine: getrackte Punkte, wo vorhanden. Fehlt ein Punkt (ausserhalb des Bildes, zu unsicher),
   * haengt das Bein gerade nach unten statt in der Ruhehaltung der Aufnahme zu bleiben. Die kann
   * gespreizt sein (ExAvatar steht als X). Der Fuss bleibt dann flach und dreht nur mit dem Becken.
   * P = null: ganz ohne Punkte (nur Oberkoerper ohne festgehaltene Haltung).
   */
  private aimLegs(P: Points | null, lHip: Vec, rHip: Vec): void {
    const b = this.bones;
    const hipsTurn = b.Hips.getWorldQuaternion(new THREE.Quaternion()).multiply(
      this.rest.get(b.Hips)!.world.clone().invert(),
    );
    for (const [side, hip, kn, an, toe] of [
      ['Left', lHip, LM.lKn, LM.lAn, LM.lToe],
      ['Right', rHip, LM.rKn, LM.rAn, LM.rToe],
    ] as const) {
      const up = b[`${side}UpLeg`],
        leg = b[`${side}Leg`],
        foot = b[`${side}Foot`],
        toeBone = b[`${side}ToeBase`];
      const K = P?.[kn],
        A = P?.[an],
        T = P?.[toe];
      if (hip && K) this.aim(up, leg, hip, K);
      else this.aimDir(up, leg, DOWN);
      // Ohne Knoechel: Unterschenkel in Verlaengerung des Oberschenkels (gestrecktes Bein).
      if (K && A) this.aim(leg, foot, K, A);
      else this.aimDir(leg, foot, this.pos(leg, new THREE.Vector3()).sub(this.pos(up, _v1)));
      if (A && T) this.aim(foot, toeBone, A, T);
      else {
        // Fuss flach wie in der Ruhehaltung, nur mit dem Becken gedreht.
        _q.copy(hipsTurn).multiply(this.rest.get(foot)!.world);
        foot.parent!.getWorldQuaternion(_pq).invert();
        foot.quaternion.copy(_pq).multiply(_q);
      }
    }
  }

  /**
   * Stellt die Figur auf die gemessene Hoehe und knickt die Beine (Zwei-Knochen-IK), damit die Fuesse
   * auf dem Boden bleiben. Getrackte Beine geben vor, wohin Knie und Fuss zeigen; ungesehene Beine
   * stehen senkrecht unter der Huefte, das Knie knickt nach vorne.
   */
  private standAt(height: number, P: Points | null, lHip: Vec, rHip: Vec): void {
    const legLen = this.standHipY;
    let d = height < 0 ? Math.min(0, height + DEADZONE_DOWN) : Math.max(0, height - DEADZONE_UP);
    d = THREE.MathUtils.clamp(d, -(1 - MIN_HIP) * legLen, MAX_JUMP);

    // Hueftgelenke auf Hoehe standHipY + d ueber dem Boden. Der Boden liegt in Weltkoordinaten bei
    // restFootY (dort standen die Zehen in der Ruhehaltung).
    const floor = this.restFootY;
    const hipNow = (this.pos(this.legs[0]!.up, _v1).y + this.pos(this.legs[1]!.up, _v2).y) / 2;
    this.model.position.y += floor + legLen + d - hipNow;
    this.model.updateMatrixWorld(true);

    const b = this.bones;
    const hipsTurn = b.Hips.getWorldQuaternion(new THREE.Quaternion()).multiply(this.rest.get(b.Hips)!.world.clone().invert());
    const forward = this.restForward.clone().applyQuaternion(hipsTurn).setY(0);
    if (forward.lengthSq() < 1e-6) forward.copy(this.restForward);
    forward.normalize();
    // Nur die Drehung um die senkrechte Achse: ein aufgesetzter Fuss bleibt flach.
    const yaw = new THREE.Quaternion().setFromUnitVectors(_v1.copy(this.restForward).setY(0).normalize(), forward);

    for (const rig of this.legs) {
      const hip = this.pos(rig.up, new THREE.Vector3());
      const L = rig.side === 'Left';
      const K = P?.[L ? LM.lKn : LM.rKn],
        A = P?.[L ? LM.lAn : LM.rAn],
        T = P?.[L ? LM.lToe : LM.rToe];
      const H = L ? lHip : rHip;
      const ankle = new THREE.Vector3(),
        pole = new THREE.Vector3();
      if (H && K && A) {
        // Richtung der getrackten Glieder, Laengen des Avatars.
        const knee = hip.clone().addScaledVector(_v1.subVectors(K, H).normalize(), rig.thigh);
        ankle.copy(knee).addScaledVector(_v1.subVectors(A, K).normalize(), rig.shin);
        pole.copy(knee);
      } else {
        ankle.set(hip.x, hip.y - rig.thigh - rig.shin, hip.z);
        pole.copy(hip).addScaledVector(forward, 1).addScaledVector(DOWN, rig.thigh);
      }
      const planted = ankle.y <= floor + rig.ankle + FLOOR_EPS;
      if (planted) ankle.y = floor + rig.ankle;
      const knee = twoBoneKnee(hip, ankle, rig.thigh, rig.shin, pole, forward);
      this.aim(rig.up, rig.leg, hip, knee);
      this.aim(rig.leg, rig.foot, knee, ankle);
      if (!planted && A && T) this.aim(rig.foot, rig.toe, A, T);
      // Fuss flach (nur mit dem Becken gedreht), wenn er aufsteht oder die Zehe sonst im Boden steckt.
      if (planted || !A || !T || (rig.toe && this.pos(rig.toe, _v1).y < floor)) {
        _q.copy(yaw).multiply(this.rest.get(rig.foot)!.world);
        rig.foot.parent!.getWorldQuaternion(_pq).invert();
        rig.foot.quaternion.copy(_pq).multiply(_q);
      }
    }
  }

  /**
   * Jeder Knochen dreht sich hoechstens mit MAX_TURN_SPEED und beschleunigt hoechstens mit
   * MAX_TURN_ACCEL Richtung seiner neuen Haltung. Normale Bewegungen kommen unveraendert durch.
   */
  private limitMotion(dt: number): void {
    for (const bone of this.rest.keys()) {
      const prev = this.motion.get(bone);
      if (!prev) {
        this.motion.set(bone, { q: bone.quaternion.clone(), step: 0 });
        continue;
      }
      const angle = prev.q.angleTo(bone.quaternion);
      const step = Math.min(angle, MAX_TURN_SPEED * dt, prev.step + MAX_TURN_ACCEL * dt * dt);
      if (step < angle) {
        _q.copy(bone.quaternion);
        bone.quaternion.copy(prev.q).rotateTowards(_q, step);
      }
      prev.q.copy(bone.quaternion);
      prev.step = step;
    }
    this.model.updateMatrixWorld(true);
  }

  /** Kiefer oeffnen: um die Querachse des Kopfes, Kinn nach unten. Ohne Kiefergelenk (Roboter) nichts. */
  private openJaw(open: number): void {
    const jaw = this.bones.Jaw;
    if (!jaw || !(open > 0)) return;
    // Querachse des Kopfes in der Welt: die Ruhe-Querachse mit der Drehung des Kopfes seit der Ruhehaltung.
    const head = this.bones.Head;
    const turn = head.getWorldQuaternion(new THREE.Quaternion()).multiply(this.rest.get(head)!.world.clone().invert());
    const axis = _v1.copy(this.restLeft).applyQuaternion(turn);
    _q.setFromAxisAngle(axis, Math.min(1, open * JAW_GAIN) * JAW_MAX).multiply(jaw.getWorldQuaternion(_pq));
    jaw.parent!.getWorldQuaternion(_pq).invert();
    jaw.quaternion.copy(_pq).multiply(_q);
  }

  /** Merkt sich die aktuelle Haltung von Huefte und Beinen fuer den Modus "nur Oberkoerper". */
  holdLowerBody(): void {
    this.lowerPose = LOWER_BODY.flatMap((n) => {
      const bone = this.bones[n];
      return bone ? [[bone, bone.quaternion.clone()] as [THREE.Bone, THREE.Quaternion]] : [];
    });
  }

  /** P: 33 Koerperpunkte. hands: je 21 Handpunkte oder null. */
  apply(P: Points, hands: HandPoints = {}, options: ApplyOptions = {}): void {
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
    const face = options.face;
    if (face) {
      this.orient(b.Head, basis.set(face.q[0], face.q[1], face.q[2], face.q[3]));
      this.openJaw(face.jaw);
    } else if (nose && lEar && rEar) {
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
    // Nur Oberkoerper ohne festgehaltene Haltung (z. B. SMPL-X-Mitlaeufer): Beine gerade.
    else if (!this.lowerPose) this.aimLegs(null, null, null);

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

    const height = options.height;
    if (height === null || height === undefined || !Number.isFinite(height)) {
      // Tiefster Fuss bleibt auf dem Boden.
      this.model.position.y = this.restFootY - this.lowestFoot();
    } else this.standAt(height, upper ? null : P, lHip, rHip);

    if (options.dt !== undefined && options.dt > 0) this.limitMotion(Math.min(options.dt, 0.1));

    for (const f of this.followers) {
      f.upperBodyOnly = upper;
      f.apply(P, hands, options);
    }
  }
}
