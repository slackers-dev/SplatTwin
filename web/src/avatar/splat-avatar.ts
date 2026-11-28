// Haengt den Gaussian Splat der Person an das getrackte Skelett.
//
// Der Splat hat kein Skelett. Der Roboter schon, samt Gewichten, die sagen, wie
// stark jeder Punkt seiner Oberflaeche an welchem Knochen haengt. Diese Gewichte
// werden auf den Splat uebertragen:
//   1. Der Roboter nimmt die Haltung der Aufnahme ein. Der Splat wird in Koerperteile
//      zerlegt und jeder Teil auf das entsprechende Glied des Roboters gelegt
//      (gleicht die anderen Proportionen aus), an den Gelenken ueberblendet.
//   2. Jeder Klecks uebernimmt die Gewichte des naechsten Punktes auf dem Roboter.
//   3. Pro Bild verformt Spark den Splat mit den Knochen (Dual-Quaternion-Skinning).
// Schritte 1 und 2 dauern einige Sekunden und haengen nur vom Lauf ab: Mit upload rechnet die
// Tracking-Seite sie einmal und speichert sie als skin.bin (skin-cache.ts), danach laden alle anderen
// nur diese Datei.
import { PackedSplats, SparkRenderer, SplatMesh, SplatSkinning } from '@sparkjsdev/spark';
import * as THREE from 'three';
import type { RunRig, RunSplat } from '../contracts';
import { type JointName, LM } from '../core/landmarks';
import type { Points } from './points';
import type { Retargeter } from './retarget';
import { decodeSkin, encodeSkin, fetchSkin, type Skin, uploadSkin } from './skin-cache';
import { loadSmplxAvatar } from './smplx-avatar';
import { robotMeshes, type SplatAvatar, splatAvatar } from './splat-view';

export type { SplatAvatar, SplatView } from './splat-view';

export interface SplatAvatarOptions {
  /** Jeden Koerperteil einfaerben, um die Zuteilung der Kleckse zu pruefen. */
  debugParts?: boolean;
  /** Fehlt skin.bin, nach dem Rechnen hochladen (Tracking-Seite: Presenter und dieser Rechner). */
  upload?: boolean;
  /** skin.bin nicht benutzen (passt nicht zum Modell): neu rechnen. */
  noSkin?: boolean;
}

/** Ein Koerperteil: Knochen, Strecke in der Person (a, b), dieselbe Strecke im Roboter (ax, bx),
 * Dicke r und der Bereich t0..t1 entlang der Strecke. */
interface Part {
  bone: THREE.Bone;
  a: THREE.Vector3;
  b: THREE.Vector3;
  ax: THREE.Vector3;
  bx: THREE.Vector3;
  r: number;
  t0: number;
  t1: number;
  torso?: boolean;
  splats: Blob[];
  neighbours: Part[];
  q: THREE.Quaternion;
  k: number;
}

/** Ein Klecks waehrend der Zuteilung. */
interface Blob {
  c: THREE.Vector3;
  s: THREE.Vector3;
  q: THREE.Quaternion;
  o: number;
  col: THREE.Color;
  near: Part | null;
  weight: number;
}

/** Ordner eines Laufs, wie der Server ihn ausliefert (data/runs/<lauf>/). */
export const runUrl = (run: string): string => `/runs/${encodeURIComponent(run)}/`;

const lerp = (a: THREE.Vector3, b: THREE.Vector3, t = 0.5) => a.clone().lerp(b, t);

/** Abstand von p zur Strecke a-b, die ueber t in [t0, t1] laeuft (0 = a, 1 = b). */
function segmentDistance(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, t0: number, t1: number): number {
  const ab = b.clone().sub(a);
  const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / ab.lengthSq(), t0, t1);
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

/** Legt die Strecke der Person auf die Strecke des Roboters (verschieben, drehen, gleichmaessig skalieren). */
function place(part: Part, c: THREE.Vector3): THREE.Vector3 {
  return c.clone().sub(part.a).applyQuaternion(part.q).multiplyScalar(part.k).add(part.ax);
}

async function getJson<T>(base: string, name: string, run: string): Promise<T> {
  const r = await fetch(base + name);
  if (!r.ok) throw new Error(`${name} fehlt fuer den Lauf ${run}`);
  return (await r.json()) as T;
}

export async function loadSplatAvatar(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  retargeter: Retargeter,
  run: string,
  options: SplatAvatarOptions = {},
): Promise<SplatAvatar> {
  const { debugParts = false, upload = false, noSkin = false } = options;
  const base = runUrl(run);
  // Avatar von LHM++ mit SMPL-X-Skelett und Gewichten: ohne Roboter-Skelett verformen.
  const smplx = await fetch(base + 'smplx.json');
  if (smplx.ok) return loadSmplxAvatar(scene, renderer, retargeter, run, await smplx.json(), { debugParts });
  const [pose, rig] = await Promise.all([getJson<RunSplat>(base, 'splat.json', run), getJson<RunRig>(base, 'rig.json', run)]);
  // Alles Laden vor der Bindehaltung: danach laeuft alles ohne await durch, sodass neue Tracking-Bilder
  // das Skelett nicht mitten in der Rechnung verstellen (auf der Buehne laeuft das Tracking schon).
  const skinBuf = debugParts || noSkin ? null : await fetchSkin(base);
  let source: PackedSplats | null = null;
  if (!skinBuf) {
    source = new PackedSplats({ url: base + 'splat.ply' });
    await source.initialized;
  }

  // Gelenke der Person (S) und des Roboters in Ruhepose (X), beide in Metern,
  // y nach oben, Blick nach +z.
  const S = Object.fromEntries(Object.entries(rig.joints).map(([k, p]) => [k, new THREE.Vector3(...p)])) as Record<
    JointName,
    THREE.Vector3
  >;
  for (const name of ['lSh', 'rSh', 'lHip', 'rHip', 'lEar', 'rEar', 'lEl', 'rEl', 'lWr', 'rWr', 'lKn', 'rKn', 'lAn', 'rAn'] as const) {
    if (!S[name]) throw new Error(`rig.json ohne Gelenk ${name}`);
  }
  const b = retargeter.bones;
  // Den Roboter in die Haltung der Aufnahme bringen (A-Pose) und in dieser Haltung binden.
  // So muss der Splat kaum verbogen werden, und wenn das Tracking spaeter dieselbe Haltung
  // liefert, erscheint er unveraendert.
  const P: Points = new Array(33).fill(null);
  for (const [key, index] of Object.entries(LM)) P[index] = S[key as JointName] ?? null;
  const upperOnly = retargeter.upperBodyOnly;
  retargeter.upperBodyOnly = false; // Bindehaltung immer mit der ganzen Aufnahme
  retargeter.apply(P);
  retargeter.upperBodyOnly = upperOnly;
  // Im Modus "nur Oberkoerper" bleiben Huefte und Beine in dieser Haltung: Der Splat
  // wird dort dann gar nicht verformt.
  retargeter.holdLowerBody();
  retargeter.model.updateMatrixWorld(true);
  const X = (name: string) => {
    const bone = b[name];
    if (!bone) throw new Error(`Knochen ${name} fehlt im Roboter`);
    return bone.getWorldPosition(new THREE.Vector3());
  };

  const shS = lerp(S.lSh, S.rSh),
    hipS = lerp(S.lHip, S.rHip),
    earS = lerp(S.lEar, S.rEar);
  const shX = lerp(X('LeftArm'), X('RightArm')),
    hipX = lerp(X('LeftUpLeg'), X('RightUpLeg'));
  const headX = b.HeadTop_End ? lerp(X('Head'), X('HeadTop_End')) : X('Head').add(new THREE.Vector3(0, 0.1, 0));

  const part = (p: Omit<Part, 'splats' | 'neighbours' | 'q' | 'k'>): Part => ({
    ...p,
    splats: [],
    neighbours: [],
    q: new THREE.Quaternion(),
    k: 1,
  });
  const parts: Part[] = [
    part({ bone: b.Hips, a: hipS, b: lerp(hipS, shS), ax: hipX, bx: lerp(hipX, shX), r: 0.17, t0: -0.4, t1: 1, torso: true }),
    part({ bone: b.Spine2 ?? b.Spine, a: lerp(hipS, shS), b: shS, ax: lerp(hipX, shX), bx: shX, r: 0.17, t0: 0, t1: 1, torso: true }),
    part({ bone: b.Head, a: shS, b: earS, ax: shX, bx: headX, r: 0.11, t0: 0.3, t1: 2 }),
  ];
  for (const [side, s] of [['Left', 'l'], ['Right', 'r']] as const) {
    const sh = S[`${s}Sh`],
      el = S[`${s}El`],
      wr = S[`${s}Wr`],
      hip = S[`${s}Hip`],
      kn = S[`${s}Kn`],
      an = S[`${s}An`];
    const handX = X(`${side}Hand`),
      fingerX = b[`${side}HandMiddle1`] ? X(`${side}HandMiddle1`) : null;
    parts.push(
      part({ bone: b[`${side}Arm`], a: sh, b: el, ax: X(`${side}Arm`), bx: X(`${side}ForeArm`), r: 0.06, t0: 0, t1: 1 }),
      part({ bone: b[`${side}ForeArm`], a: el, b: wr, ax: X(`${side}ForeArm`), bx: handX, r: 0.055, t0: 0, t1: fingerX ? 1 : 1.8 }),
      part({ bone: b[`${side}UpLeg`], a: hip, b: kn, ax: X(`${side}UpLeg`), bx: X(`${side}Leg`), r: 0.1, t0: 0, t1: 1 }),
      part({ bone: b[`${side}Leg`], a: kn, b: an, ax: X(`${side}Leg`), bx: X(`${side}Foot`), r: 0.08, t0: 0, t1: 1.8 }),
    );
    if (fingerX) {
      const len = handX.distanceTo(fingerX);
      const tip = wr.clone().addScaledVector(wr.clone().sub(el).normalize(), len);
      parts.push(part({ bone: b[`${side}Hand`], a: wr, b: tip, ax: handX, bx: fingerX, r: 0.055, t0: 0, t1: 2.2 }));
    }
  }

  /** 1. Kleckse den Koerperteilen zuteilen und auf den Roboter legen. */
  const assignParts = (src: PackedSplats): Blob[] => {
    // Jeden Klecks aufrichten (splat.json) und dem naechsten Koerperteil zuteilen.
    const pos = new THREE.Vector3(),
      rot = new THREE.Quaternion(),
      scl = new THREE.Vector3();
    new THREE.Matrix4().set(...(pose.matrix.flat() as Parameters<THREE.Matrix4['set']>)).decompose(pos, rot, scl);
    const upright = new THREE.Matrix4().compose(pos, rot, scl);
    // Nachbarn: das Teil, dessen Knochen im Skelett als naechster darueber liegt, und umgekehrt.
    const byBone = new Map<THREE.Object3D, Part>(parts.map((p) => [p.bone, p]));
    for (const p of parts) {
      let up = p.bone.parent;
      while (up && !byBone.has(up)) up = up.parent;
      const above = up ? byBone.get(up) : undefined;
      if (above) {
        p.neighbours.push(above);
        above.neighbours.push(p);
      }
    }
    const halfShoulders = (S.lSh.distanceTo(S.rSh) / 2) * 1.05;
    src.forEachSplat((_i, center, scales, quaternion, opacity, color) => {
      const c = center.clone().applyMatrix4(upright);
      let best = parts[0]!,
        bestD = Infinity;
      const dist = new Map<Part, number>();
      for (const p of parts) {
        // Was seitlich ueber die Schultern hinausragt, ist Arm und nie Rumpf.
        if (p.torso && Math.abs(c.x - shS.x) > halfShoulders) continue;
        const d = segmentDistance(c, p.a, p.b, p.t0, p.t1) / p.r;
        dist.set(p, d);
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      // Naechster Nachbar im Skelett: nahe an der Grenze wird zwischen beiden Teilen
      // ueberblendet, damit an Schulter, Ellbogen, Hueftgelenk und Knie nichts aufreisst.
      let near: Part | null = null,
        nearD = Infinity;
      for (const other of best.neighbours) {
        const d = dist.get(other);
        if (d !== undefined && d < nearD) {
          nearD = d;
          near = other;
        }
      }
      const weight = near ? 1 / (1 + Math.exp(-(nearD - bestD) / 0.25)) : 1;
      const col = debugParts ? new THREE.Color().setHSL((parts.indexOf(best) * 0.31) % 1, 0.9, 0.5) : color.clone();
      best.splats.push({ c, s: scales.clone().multiplyScalar(scl.x), q: quaternion.clone().premultiply(rot), o: opacity, col, near, weight });
    });

    // 1. Jeden Koerperteil in die Ruhepose des Roboters legen.
    for (const p of parts) {
      const dS = p.b.clone().sub(p.a),
        dX = p.bx.clone().sub(p.ax);
      p.q = new THREE.Quaternion().setFromUnitVectors(dS.clone().normalize(), dX.clone().normalize());
      p.k = dX.length() / dS.length();
    }
    const all: Blob[] = [];
    for (const p of parts) {
      for (const g of p.splats) {
        const here = place(p, g.c),
          turn = p.q.clone();
        let k = p.k;
        if (g.near && g.weight < 0.98) {
          here.lerp(place(g.near, g.c), 1 - g.weight);
          turn.slerp(g.near.q, 1 - g.weight);
          k = k * g.weight + g.near.k * (1 - g.weight);
        }
        g.c = here;
        g.q.premultiply(turn);
        g.s.multiplyScalar(k);
        all.push(g);
      }
    }
    return all;
  };

  // Knochen des Roboters in der Bindehaltung: an ihnen haengt der Splat.
  const robot = robotMeshes(retargeter);
  const bones: THREE.Bone[] = [],
    boneIndex = new Map<THREE.Bone, number>();
  for (const m of robot) {
    m.skeleton.update();
    for (const bone of m.skeleton.bones) {
      if (!boneIndex.has(bone)) {
        boneIndex.set(bone, bones.length);
        bones.push(bone);
      }
    }
  }
  // Bindehaltung der Knochen jetzt festhalten: das Tracking darf sie danach schon bewegen.
  const rest = bones.map((bone) => ({
    q: bone.getWorldQuaternion(new THREE.Quaternion()).invert(),
    p: bone.getWorldPosition(new THREE.Vector3()),
  }));

  /** 2. Gewichte vom naechsten Punkt der Roboter-Oberflaeche uebernehmen. */
  const computeSkin = (src: PackedSplats): Skin => {
    const all = assignParts(src);
    const verts: { mesh: THREE.SkinnedMesh; i: number }[] = [];
    const xyzList: number[] = [];
    const v = new THREE.Vector3();
    for (const m of robot) {
      const n = m.geometry.attributes.position!.count;
      for (let i = 0; i < n; i++) {
        m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld);
        verts.push({ mesh: m, i });
        xyzList.push(v.x, v.y, v.z);
      }
    }
    const xyz = new Float32Array(xyzList);
    const idx = new Uint8Array(all.length * 4),
      w = new Uint8Array(all.length * 4);
    const si = new THREE.Vector4(),
      sw = new THREE.Vector4();
    all.forEach((g, n) => {
      let best = 0,
        bestD = Infinity;
      for (let i = 0; i < xyz.length; i += 3) {
        const dx = xyz[i]! - g.c.x,
          dy = xyz[i + 1]! - g.c.y,
          dz = xyz[i + 2]! - g.c.z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = i / 3;
        }
      }
      const { mesh: src, i } = verts[best]!;
      si.fromBufferAttribute(src.geometry.attributes.skinIndex as THREE.BufferAttribute, i);
      sw.fromBufferAttribute(src.geometry.attributes.skinWeight as THREE.BufferAttribute, i);
      sw.divideScalar(sw.x + sw.y + sw.z + sw.w);
      (['x', 'y', 'z', 'w'] as const).forEach((c, k) => {
        idx[n * 4 + k] = boneIndex.get(src.skeleton.bones[si[c]]!)!;
        w[n * 4 + k] = Math.round(sw[c] * 255);
      });
    });
    return { splats: all, idx, w };
  };

  let skin = skinBuf ? decodeSkin(skinBuf, retargeter.model, bones) : null;
  if (!skin) {
    // skin.bin passt nicht zum Modell (selten): ohne neu laden und rechnen.
    if (!source) return loadSplatAvatar(scene, renderer, retargeter, run, { ...options, noSkin: true });
    skin = computeSkin(source);
    if (upload && !debugParts) uploadSkin(run, encodeSkin(skin, retargeter.model, bones));
  }
  const { splats, idx: boneIdx, w: boneW } = skin;

  const dq = new THREE.Quaternion(),
    t = new THREE.Vector3(),
    tmp = new THREE.Vector3();
  let skinning: SplatSkinning | null = null;
  // 3. Pro Bild: Bewegung jedes Knochens gegenueber der Ruhepose (Drehung dq und
  // Verschiebung t, sodass p' = dq * p + t) an Spark uebergeben.
  const updateBones = () => {
    if (!skinning) return;
    retargeter.model.updateMatrixWorld(true);
    bones.forEach((bone, i) => {
      bone.getWorldQuaternion(dq).multiply(rest[i]!.q);
      bone.getWorldPosition(t).sub(tmp.copy(rest[i]!.p).applyQuaternion(dq));
      skinning!.setBoneQuatPos(i, dq, t);
    });
    skinning.updateBones();
  };

  const mesh = new SplatMesh({
    constructSplats: (out) => {
      for (const g of splats) out.pushSplat(g.c, g.s, g.q, g.o, g.col);
    },
    onFrame: () => updateBones(),
  });
  await mesh.initialized;
  skinning = new SplatSkinning({ mesh, numSplats: splats.length, numBones: bones.length });
  const idx = new THREE.Vector4(),
    w = new THREE.Vector4();
  for (let n = 0; n < splats.length; n++) {
    idx.fromArray(boneIdx, n * 4);
    w.fromArray(boneW, n * 4);
    skinning.setSplatBones(n, idx, w.divideScalar(Math.max(1, w.x + w.y + w.z + w.w)));
  }
  skinning.skinTexture.needsUpdate = true;
  bones.forEach((_, i) => skinning!.setRestQuatPos(i, new THREE.Quaternion(), new THREE.Vector3()));

  mesh.skinning = skinning;
  mesh.updateGenerator();
  // Ein SparkRenderer pro Szene reicht, auch fuer mehrere Splats (Buehne mit zwei Presentern).
  if (!scene.children.some((o) => o instanceof SparkRenderer)) scene.add(new SparkRenderer({ renderer }));
  scene.add(mesh);

  return splatAvatar(retargeter, mesh, splats.length, () => {
    scene.remove(mesh);
    mesh.dispose();
  });
}
