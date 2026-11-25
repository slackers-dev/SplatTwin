// Vorgerechneter Splat (data/runs/<lauf>/skin.bin): die Kleckse schon auf den Roboter gelegt, mit den
// Knochen und Gewichten aus splat-avatar.ts. Das Zuteilen dauert einige Sekunden (jeder Klecks sucht den
// naechsten Punkt des Roboters) und haengt nur vom Lauf ab: einmal rechnen, hochladen, danach laden alle
// nur noch diese Datei. Etwa 40 Bytes pro Klecks statt der ganzen PLY (fuer 11 500 Kleckse 460 KB statt
// 2,7 MB), und kein Rechnen auf dem Handy.
//
// Format (Little Endian): "SKN1", u32 Anzahl N, u32 Laenge L des Kopfs, Kopf als JSON {"bones": [Namen]}
// mit Leerzeichen auf 4 Bytes aufgefuellt, dann Float32 Mitte N*3, Float32 Groesse N*3, Int8 Drehung N*4
// (x 127), Uint8 Deckkraft N, Uint8 Farbe N*3, Uint8 Knochen N*4, Uint8 Gewicht N*4 (Summe ~255).
// Positionen relativ zum Roboter, also unabhaengig davon, wo er auf der Buehne steht.
import * as THREE from 'three';

export interface SkinSplat {
  c: THREE.Vector3;
  s: THREE.Vector3;
  q: THREE.Quaternion;
  o: number;
  col: THREE.Color;
}

export interface Skin {
  splats: SkinSplat[];
  /** je Klecks 4 Knochen (Index in bones) */
  idx: Uint8Array;
  /** je Klecks 4 Gewichte, zusammen etwa 255 */
  w: Uint8Array;
}

const MAGIC = [83, 75, 78, 49]; // "SKN1"
const BYTES_PER_SPLAT = 12 + 12 + 4 + 1 + 3 + 4 + 4;

function frameOf(model: THREE.Object3D) {
  const p = new THREE.Vector3(),
    q = new THREE.Quaternion(),
    s = new THREE.Vector3();
  model.matrixWorld.decompose(p, q, s);
  return { m: model.matrixWorld, q, k: s.x };
}

export function encodeSkin({ splats, idx, w }: Skin, model: THREE.Object3D, bones: readonly THREE.Bone[]): ArrayBuffer {
  const N = splats.length;
  const head = new TextEncoder().encode(JSON.stringify({ bones: bones.map((b) => b.name) }));
  const headLen = Math.ceil(head.length / 4) * 4;
  const buf = new ArrayBuffer(12 + headLen + N * BYTES_PER_SPLAT);
  const bytes = new Uint8Array(buf);
  bytes.set(MAGIC);
  const dv = new DataView(buf);
  dv.setUint32(4, N, true);
  dv.setUint32(8, headLen, true);
  bytes.set(head, 12);
  bytes.fill(32, 12 + head.length, 12 + headLen);
  let o = 12 + headLen;
  const C = new Float32Array(buf, o, N * 3);
  o += N * 12;
  const S = new Float32Array(buf, o, N * 3);
  o += N * 12;
  const Q = new Int8Array(buf, o, N * 4);
  o += N * 4;
  const O = new Uint8Array(buf, o, N);
  o += N;
  const RGB = new Uint8Array(buf, o, N * 3);
  o += N * 3;
  new Uint8Array(buf, o, N * 4).set(idx);
  o += N * 4;
  new Uint8Array(buf, o, N * 4).set(w);

  const f = frameOf(model),
    inv = f.m.clone().invert(),
    qi = f.q.clone().invert();
  const c = new THREE.Vector3(),
    q = new THREE.Quaternion();
  const u8 = (x: number) => Math.max(0, Math.min(255, Math.round(x * 255)));
  splats.forEach((g, n) => {
    c.copy(g.c).applyMatrix4(inv).toArray(C, n * 3);
    S.set([g.s.x / f.k, g.s.y / f.k, g.s.z / f.k], n * 3);
    q.copy(g.q).premultiply(qi).normalize();
    Q.set([q.x, q.y, q.z, q.w].map((x) => Math.round(x * 127)), n * 4);
    O[n] = u8(g.o);
    RGB.set([u8(g.col.r), u8(g.col.g), u8(g.col.b)], n * 3);
  });
  return buf;
}

/** null, wenn die Datei nicht passt (z. B. anderes Modell): dann neu rechnen. */
export function decodeSkin(buf: ArrayBuffer, model: THREE.Object3D, bones: readonly THREE.Bone[]): Skin | null {
  try {
    const bytes = new Uint8Array(buf);
    if (MAGIC.some((m, i) => bytes[i] !== m)) return null;
    const dv = new DataView(buf);
    const N = dv.getUint32(4, true),
      headLen = dv.getUint32(8, true);
    if (buf.byteLength !== 12 + headLen + N * BYTES_PER_SPLAT) return null;
    const names = (JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + headLen))) as { bones: string[] }).bones;
    const byName = new Map(bones.map((b, i) => [b.name, i]));
    const remap = names.map((n) => byName.get(n));
    if (remap.some((i) => i === undefined)) return null;
    let o = 12 + headLen;
    const C = new Float32Array(buf, o, N * 3);
    o += N * 12;
    const S = new Float32Array(buf, o, N * 3);
    o += N * 12;
    const Q = new Int8Array(buf, o, N * 4);
    o += N * 4;
    const O = new Uint8Array(buf, o, N);
    o += N;
    const RGB = new Uint8Array(buf, o, N * 3);
    o += N * 3;
    const idx = new Uint8Array(buf, o, N * 4).map((i) => remap[i]!);
    o += N * 4;
    const w = new Uint8Array(buf, o, N * 4);
    const f = frameOf(model);
    const splats: SkinSplat[] = new Array(N);
    for (let n = 0; n < N; n++) {
      splats[n] = {
        c: new THREE.Vector3().fromArray(C, n * 3).applyMatrix4(f.m),
        s: new THREE.Vector3().fromArray(S, n * 3).multiplyScalar(f.k),
        q: new THREE.Quaternion(Q[n * 4]! / 127, Q[n * 4 + 1]! / 127, Q[n * 4 + 2]! / 127, Q[n * 4 + 3]! / 127)
          .normalize()
          .premultiply(f.q),
        o: O[n]! / 255,
        col: new THREE.Color(RGB[n * 3]! / 255, RGB[n * 3 + 1]! / 255, RGB[n * 3 + 2]! / 255),
      };
    }
    return { splats, idx, w };
  } catch (err) {
    console.warn('skin.bin nicht lesbar, rechne neu:', err);
    return null;
  }
}

export async function fetchSkin(base: string): Promise<ArrayBuffer | null> {
  try {
    const r = await fetch(base + 'skin.bin');
    return r.ok ? await r.arrayBuffer() : null;
  } catch {
    return null;
  }
}

/** Fuer alle anderen speichern (nur Presenter und dieser Rechner duerfen das). */
export function uploadSkin(run: string, buf: ArrayBuffer): void {
  fetch(`/api/skin?run=${encodeURIComponent(run)}`, { method: 'POST', body: buf })
    .then((r) => r.json())
    .then((r) => console.info('Splat vorgerechnet und gespeichert:', r))
    .catch((err: unknown) => console.warn('skin.bin nicht hochgeladen:', err));
}
