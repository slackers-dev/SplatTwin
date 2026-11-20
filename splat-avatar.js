// Machbarkeitstest: haengt den Gaussian Splat der Person an das getrackte Skelett.
//
// Der Splat hat kein Skelett. Der Roboter schon, samt Gewichten, die sagen, wie
// stark jeder Punkt seiner Oberflaeche an welchem Knochen haengt. Diese Gewichte
// werden auf den Splat uebertragen:
//   1. Der Roboter nimmt die Haltung der Aufnahme ein. Der Splat wird in Koerperteile
//      zerlegt und jeder Teil auf das entsprechende Glied des Roboters gelegt
//      (gleicht die anderen Proportionen aus), an den Gelenken ueberblendet.
//   2. Jeder Klecks uebernimmt die Gewichte des naechsten Punktes auf dem Roboter.
//   3. Pro Bild verformt Spark den Splat mit den Knochen (Dual-Quaternion-Skinning).

import * as THREE from 'three';
import { PackedSplats, SparkRenderer, SplatMesh, SplatSkinning } from '@sparkjsdev/spark';
import { LM } from './retarget.js';

const lerp = (a, b, t = 0.5) => a.clone().lerp(b, t);
const DEBUG_PARTS = new URLSearchParams(location.search).has('parts');

// Abstand von p zur Strecke a-b, die ueber t in [t0, t1] laeuft (0 = a, 1 = b).
function segmentDistance(p, a, b, t0, t1) {
  const ab = b.clone().sub(a);
  const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / ab.lengthSq(), t0, t1);
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

export async function loadSplatAvatar(scene, renderer, retargeter, run) {
  const base = `./splat/runs/${encodeURIComponent(run)}/`;
  const getJson = async (name) => {
    const r = await fetch(base + name);
    if (!r.ok) throw new Error(`${name} fehlt fuer den Lauf ${run}`);
    return r.json();
  };
  const [pose, rig] = await Promise.all([getJson('splat.json'), getJson('rig.json')]);
  const source = new PackedSplats({ url: base + 'splat.ply' });
  await source.initialized;

  // Gelenke der Person (S) und des Roboters in Ruhepose (X), beide in Metern,
  // y nach oben, Blick nach +z.
  const S = Object.fromEntries(Object.entries(rig.joints).map(([k, p]) => [k, new THREE.Vector3(...p)]));
  const b = retargeter.bones;
  // Den Roboter in die Haltung der Aufnahme bringen (A-Pose) und in dieser Haltung binden.
  // So muss der Splat kaum verbogen werden, und wenn das Tracking spaeter dieselbe Haltung
  // liefert, erscheint er unveraendert.
  const P = new Array(33).fill(null);
  for (const [key, index] of Object.entries(LM)) if (S[key]) P[index] = S[key];
  retargeter.apply(P);
  retargeter.model.updateMatrixWorld(true);
  const X = (name) => b[name].getWorldPosition(new THREE.Vector3());

  const shS = lerp(S.lSh, S.rSh), hipS = lerp(S.lHip, S.rHip), earS = lerp(S.lEar, S.rEar);
  const shX = lerp(X('LeftArm'), X('RightArm')), hipX = lerp(X('LeftUpLeg'), X('RightUpLeg'));
  const headX = b.HeadTop_End ? lerp(X('Head'), X('HeadTop_End')) : X('Head').add(new THREE.Vector3(0, 0.1, 0));

  // Koerperteil: Knochen, Strecke in der Person (a, b), dieselbe Strecke im Roboter
  // (ax, bx), Dicke r und der Bereich t0..t1 entlang der Strecke.
  const parts = [
    { bone: b.Hips, a: hipS, b: lerp(hipS, shS), ax: hipX, bx: lerp(hipX, shX), r: 0.17, t0: -0.4, t1: 1, torso: true },
    { bone: b.Spine2 || b.Spine, a: lerp(hipS, shS), b: shS, ax: lerp(hipX, shX), bx: shX, r: 0.17, t0: 0, t1: 1, torso: true },
    { bone: b.Head, a: shS, b: earS, ax: shX, bx: headX, r: 0.11, t0: 0.3, t1: 2 },
  ];
  for (const [side, s] of [['Left', 'l'], ['Right', 'r']]) {
    const sh = S[s + 'Sh'], el = S[s + 'El'], wr = S[s + 'Wr'], hip = S[s + 'Hip'], kn = S[s + 'Kn'], an = S[s + 'An'];
    const handX = X(side + 'Hand'), fingerX = b[side + 'HandMiddle1'] ? X(side + 'HandMiddle1') : null;
    parts.push(
      { bone: b[side + 'Arm'], a: sh, b: el, ax: X(side + 'Arm'), bx: X(side + 'ForeArm'), r: 0.06, t0: 0, t1: 1 },
      { bone: b[side + 'ForeArm'], a: el, b: wr, ax: X(side + 'ForeArm'), bx: handX, r: 0.055, t0: 0, t1: fingerX ? 1 : 1.8 },
      { bone: b[side + 'UpLeg'], a: hip, b: kn, ax: X(side + 'UpLeg'), bx: X(side + 'Leg'), r: 0.1, t0: 0, t1: 1 },
      { bone: b[side + 'Leg'], a: kn, b: an, ax: X(side + 'Leg'), bx: X(side + 'Foot'), r: 0.08, t0: 0, t1: 1.8 },
    );
    if (fingerX) {
      const len = handX.distanceTo(fingerX);
      const tip = wr.clone().addScaledVector(wr.clone().sub(el).normalize(), len);
      parts.push({ bone: b[side + 'Hand'], a: wr, b: tip, ax: handX, bx: fingerX, r: 0.055, t0: 0, t1: 2.2 });
    }
  }

  // Jeden Klecks aufrichten (splat.json) und dem naechsten Koerperteil zuteilen.
  const pos = new THREE.Vector3(), rot = new THREE.Quaternion(), scl = new THREE.Vector3();
  new THREE.Matrix4().set(...pose.matrix.flat()).decompose(pos, rot, scl);
  const upright = new THREE.Matrix4().compose(pos, rot, scl);
  for (const part of parts) part.splats = [];
  // Nachbarn: das Teil, dessen Knochen im Skelett als naechster darueber liegt, und umgekehrt.
  const byBone = new Map(parts.map((part) => [part.bone, part]));
  for (const part of parts) part.neighbours = [];
  for (const part of parts) {
    let up = part.bone.parent;
    while (up && !byBone.has(up)) up = up.parent;
    if (up) { part.neighbours.push(byBone.get(up)); byBone.get(up).neighbours.push(part); }
  }
  const halfShoulders = S.lSh.distanceTo(S.rSh) / 2 * 1.05;
  source.forEachSplat((_i, center, scales, quaternion, opacity, color) => {
    const c = center.clone().applyMatrix4(upright);
    let best = null, bestD = Infinity;
    const dist = new Map();
    for (const part of parts) {
      // Was seitlich ueber die Schultern hinausragt, ist Arm und nie Rumpf.
      if (part.torso && Math.abs(c.x - shS.x) > halfShoulders) continue;
      const d = segmentDistance(c, part.a, part.b, part.t0, part.t1) / part.r;
      dist.set(part, d);
      if (d < bestD) { bestD = d; best = part; }
    }
    // Naechster Nachbar im Skelett: nahe an der Grenze wird zwischen beiden Teilen
    // ueberblendet, damit an Schulter, Ellbogen, Hueftgelenk und Knie nichts aufreisst.
    let near = null, nearD = Infinity;
    for (const other of best.neighbours) {
      const d = dist.get(other);
      if (d !== undefined && d < nearD) { nearD = d; near = other; }
    }
    const weight = near ? 1 / (1 + Math.exp(-(nearD - bestD) / 0.25)) : 1;
    // ?parts in der Adresse faerbt jeden Koerperteil ein, um die Zuteilung zu pruefen.
    const col = DEBUG_PARTS ? new THREE.Color().setHSL((parts.indexOf(best) * 0.31) % 1, 0.9, 0.5) : color.clone();
    best.splats.push({ c, s: scales.clone().multiplyScalar(scl.x), q: quaternion.clone().premultiply(rot), o: opacity, col, near, weight });
  });

  // 1. Jeden Koerperteil in die Ruhepose des Roboters legen: die Strecke der Person
  // auf die Strecke des Roboters (verschieben, drehen, gleichmaessig skalieren).
  const all = [];
  for (const part of parts) {
    const dS = part.b.clone().sub(part.a), dX = part.bx.clone().sub(part.ax);
    part.q = new THREE.Quaternion().setFromUnitVectors(dS.clone().normalize(), dX.clone().normalize());
    part.k = dX.length() / dS.length();
    part.place = (c) => c.clone().sub(part.a).applyQuaternion(part.q).multiplyScalar(part.k).add(part.ax);
  }
  for (const part of parts) {
    for (const g of part.splats) {
      const here = part.place(g.c), turn = part.q.clone();
      let k = part.k;
      if (g.near && g.weight < 0.98) {
        here.lerp(g.near.place(g.c), 1 - g.weight);
        turn.slerp(g.near.q, 1 - g.weight);
        k = k * g.weight + g.near.k * (1 - g.weight);
      }
      g.c = here;
      g.q.premultiply(turn);
      g.s.multiplyScalar(k);
      all.push(g);
    }
  }

  // 2. Gewichte vom naechsten Punkt der Roboter-Oberflaeche uebernehmen.
  const robot = [];
  retargeter.model.traverse((o) => { if (o.isSkinnedMesh) robot.push(o); });
  const bones = [], boneIndex = new Map();
  const verts = [];
  const v = new THREE.Vector3();
  for (const mesh of robot) {
    mesh.skeleton.update();
    for (const bone of mesh.skeleton.bones) {
      if (!boneIndex.has(bone)) { boneIndex.set(bone, bones.length); bones.push(bone); }
    }
    const n = mesh.geometry.attributes.position.count;
    for (let i = 0; i < n; i++) {
      mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld);
      verts.push({ x: v.x, y: v.y, z: v.z, mesh, i });
    }
  }
  // Bindehaltung der Knochen jetzt festhalten: das Tracking darf sie danach schon bewegen.
  const rest = bones.map((bone) => ({
    q: bone.getWorldQuaternion(new THREE.Quaternion()).invert(),
    p: bone.getWorldPosition(new THREE.Vector3()),
  }));
  const xyz = new Float32Array(verts.length * 3);
  verts.forEach((p, i) => xyz.set([p.x, p.y, p.z], i * 3));

  const mesh = new SplatMesh({
    constructSplats: (out) => { for (const g of all) out.pushSplat(g.c, g.s, g.q, g.o, g.col); },
    onFrame: () => updateBones(),
  });
  await mesh.initialized;
  const skinning = new SplatSkinning({ mesh, numSplats: all.length, numBones: bones.length });
  const idx = new THREE.Vector4(), w = new THREE.Vector4();
  all.forEach((g, n) => {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < xyz.length; i += 3) {
      const dx = xyz[i] - g.c.x, dy = xyz[i + 1] - g.c.y, dz = xyz[i + 2] - g.c.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = i / 3; }
    }
    const { mesh: src, i } = verts[best];
    idx.fromBufferAttribute(src.geometry.attributes.skinIndex, i);
    w.fromBufferAttribute(src.geometry.attributes.skinWeight, i);
    for (const c of ['x', 'y', 'z', 'w']) idx[c] = boneIndex.get(src.skeleton.bones[idx[c]]);
    skinning.setSplatBones(n, idx, w.divideScalar(w.x + w.y + w.z + w.w));
  });
  skinning.skinTexture.needsUpdate = true;

  // 3. Pro Bild: Bewegung jedes Knochens gegenueber der Ruhepose (Drehung dq und
  // Verschiebung t, sodass p' = dq * p + t) an Spark uebergeben.
  const zero = new THREE.Vector3(), one = new THREE.Quaternion();
  bones.forEach((_, i) => skinning.setRestQuatPos(i, one, zero));
  const dq = new THREE.Quaternion(), t = new THREE.Vector3(), tmp = new THREE.Vector3();
  function updateBones() {
    retargeter.model.updateMatrixWorld(true);
    bones.forEach((bone, i) => {
      bone.getWorldQuaternion(dq).multiply(rest[i].q);
      bone.getWorldPosition(t).sub(tmp.copy(rest[i].p).applyQuaternion(dq));
      skinning.setBoneQuatPos(i, dq, t);
    });
    skinning.updateBones();
  }
  mesh.skinning = skinning;
  mesh.updateGenerator();
  scene.add(new SparkRenderer({ renderer }));
  scene.add(mesh);

  return {
    count: all.length,
    setVisible(on) {
      mesh.visible = on;
      for (const m of robot) m.visible = !on;
    },
  };
}
