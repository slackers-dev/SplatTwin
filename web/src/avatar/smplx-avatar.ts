// Splat-Avatar von LHM++ auf seinem eigenen SMPL-X-Skelett.
//
// LHM++ legt jeden Klecks an den SMPL-X-Koerper und verformt ihn mit Linear Blend Skinning. Die Gewichte
// (smplx_skin.bin, je die 4 staerksten Gelenke) und die Gelenke (smplx.json) schreibt
// scripts/pod-do/lhm_zum_viewer.py. Hier entsteht daraus ein three.js-Skelett mit den Namen des
// Mixamo-Skeletts, damit derselbe Retargeter es aus den getrackten Punkten drehen kann. Er haengt als
// Mitlaeufer am Retargeter des Roboters: Seiten und Buehne rufen weiter nur den Roboter auf.
// Pro Bild gibt Spark jedem Gelenk seine Bewegung gegenueber der Haltung im PLY (Dual-Quaternion-Skinning).
import { PackedSplats, SparkRenderer, SplatMesh, SplatSkinning } from '@sparkjsdev/spark';
import * as THREE from 'three';
import type { RunSmplx, RunSplat } from '../contracts';
import { Retargeter } from './retarget';
import { type SplatAvatar, splatAvatar } from './splat-view';

const hand = (side: string) =>
  ['Index', 'Middle', 'Pinky', 'Ring', 'Thumb'].flatMap((f) => [1, 2, 3].map((k) => `${side}Hand${f}${k}`));

/** Die 55 Gelenke von SMPL-X, benannt wie im Mixamo-Skelett (dort, wo es eines gibt). */
export const SMPLX_BONES = [
  'Hips', 'LeftUpLeg', 'RightUpLeg', 'Spine', 'LeftLeg', 'RightLeg', 'Spine1', 'LeftFoot', 'RightFoot',
  'Spine2', 'LeftToeBase', 'RightToeBase', 'Neck', 'LeftShoulder', 'RightShoulder', 'Head', 'LeftArm',
  'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftHand', 'RightHand', 'Jaw', 'LeftEye', 'RightEye',
  ...hand('Left'), ...hand('Right'),
]; // prettier-ignore

/** Skelett aus smplx.json: Gelenke in Weltkoordinaten, Knochen relativ zum Elterngelenk. */
export function buildSmplxSkeleton(meta: RunSmplx): { root: THREE.Group; bones: THREE.Bone[] } {
  const root = new THREE.Group();
  root.name = 'smplx';
  const bones = meta.joints.map((_, i) => {
    const b = new THREE.Bone();
    b.name = SMPLX_BONES[i] ?? `Joint${i}`;
    return b;
  });
  meta.joints.forEach((p, i) => {
    const parent = meta.parents[i]!;
    const b = bones[i]!;
    if (parent < 0) {
      root.add(b);
      b.position.set(p[0]!, p[1]!, p[2]!);
    } else {
      bones[parent]!.add(b);
      const q = meta.joints[parent]!;
      b.position.set(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);
    }
  });
  return { root, bones };
}

async function fetchOk(url: string): Promise<Response> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} fehlt`);
  return r;
}

export async function loadSmplxAvatar(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  retargeter: Retargeter,
  run: string,
  meta: RunSmplx,
  options: { debugParts?: boolean } = {},
): Promise<SplatAvatar> {
  const base = `/runs/${encodeURIComponent(run)}/`;
  const [pose, skinBuf] = await Promise.all([
    fetchOk(base + 'splat.json').then((r) => r.json() as Promise<RunSplat>),
    fetchOk(base + 'smplx_skin.bin').then((r) => r.arrayBuffer()),
  ]);
  const n = meta.count;
  if (skinBuf.byteLength !== n * 8) throw new Error(`smplx_skin.bin passt nicht zu ${n} Klecksen`);
  const boneIdx = new Uint8Array(skinBuf, 0, n * 4);
  const boneW = new Uint8Array(skinBuf, n * 4, n * 4);
  const source = new PackedSplats({ url: base + 'splat.ply' });
  await source.initialized;
  if (source.numSplats !== n) throw new Error(`splat.ply hat ${source.numSplats} Kleckse, smplx.json ${n}`);

  // Skelett neben dem Roboter einhaengen (gleiche Gruppe, z. B. Platz auf der Buehne).
  const { root, bones } = buildSmplxSkeleton(meta);
  (retargeter.model.parent ?? scene).add(root);
  root.updateMatrixWorld(true);
  // Bindehaltung = Haltung im PLY. Festhalten, bevor das Tracking das Skelett bewegt.
  const rest = bones.map((b) => ({
    q: b.getWorldQuaternion(new THREE.Quaternion()).invert(),
    p: b.getWorldPosition(new THREE.Vector3()),
  }));
  const follower = new Retargeter(root);
  retargeter.followers.push(follower);

  // PLY -> Welt: splat.json (Fuesse auf den Boden), dann die Gruppe, in der das Skelett haengt.
  const upright = new THREE.Matrix4().set(...(pose.matrix.flat() as Parameters<THREE.Matrix4['set']>));
  const toWorld = root.matrixWorld.clone().multiply(upright);
  const turn = new THREE.Quaternion().setFromRotationMatrix(toWorld);
  const grow = new THREE.Vector3().setFromMatrixScale(toWorld).x;
  const color = new THREE.Color();

  const mesh = new SplatMesh({
    constructSplats: (out) => {
      source.forEachSplat((i, center, scales, quaternion, opacity, col) => {
        if (options.debugParts) col = color.setHSL((boneIdx[i * 4]! * 0.137) % 1, 0.9, 0.5);
        out.pushSplat(center.applyMatrix4(toWorld), scales.multiplyScalar(grow), quaternion.premultiply(turn), opacity, col);
      });
    },
    onFrame: () => updateBones(),
  });
  await mesh.initialized;

  const skinning = new SplatSkinning({ mesh, numSplats: n, numBones: bones.length });
  const idx = new THREE.Vector4(),
    w = new THREE.Vector4();
  for (let i = 0; i < n; i++) {
    idx.fromArray(boneIdx, i * 4);
    w.fromArray(boneW, i * 4);
    skinning.setSplatBones(i, idx, w.divideScalar(Math.max(1, w.x + w.y + w.z + w.w)));
  }
  skinning.skinTexture.needsUpdate = true;
  bones.forEach((_, i) => skinning.setRestQuatPos(i, new THREE.Quaternion(), new THREE.Vector3()));
  mesh.skinning = skinning;
  mesh.updateGenerator();

  const dq = new THREE.Quaternion(),
    t = new THREE.Vector3(),
    tmp = new THREE.Vector3();
  // Bewegung jedes Gelenks gegenueber der Bindehaltung (p' = dq * p + t) an Spark geben.
  function updateBones(): void {
    // Die Seite setzt die Position im Raum am Roboter, nach dem Retargeting: hier uebernehmen.
    root.position.x = retargeter.model.position.x;
    root.position.z = retargeter.model.position.z;
    root.updateMatrixWorld(true);
    bones.forEach((bone, i) => {
      bone.getWorldQuaternion(dq).multiply(rest[i]!.q);
      bone.getWorldPosition(t).sub(tmp.copy(rest[i]!.p).applyQuaternion(dq));
      skinning.setBoneQuatPos(i, dq, t);
    });
    skinning.updateBones();
  }

  if (!scene.children.some((o) => o instanceof SparkRenderer)) scene.add(new SparkRenderer({ renderer }));
  scene.add(mesh);

  return splatAvatar(retargeter, mesh, n, () => {
    retargeter.followers.splice(retargeter.followers.indexOf(follower), 1);
    root.removeFromParent();
    scene.remove(mesh);
    mesh.dispose();
  });
}
