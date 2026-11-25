// Kontroll-Skelett neben dem Avatar: rot die Messung, gruen nach dem Filter.
import * as THREE from 'three';
import { POSE_BONES } from '../core/landmarks';
import type { Points } from './points';

export class DebugSkeleton {
  readonly lines: THREE.LineSegments;

  constructor(scene: THREE.Scene, color: number) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(POSE_BONES.length * 6), 3));
    this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color }));
    this.lines.frustumCulled = false;
    this.lines.position.set(1.1, 1, 0);
    scene.add(this.lines);
  }

  set visible(on: boolean) {
    this.lines.visible = on;
  }

  update(pts: Points): void {
    const attr = this.lines.geometry.attributes.position as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    let n = 0;
    for (const [i, j] of POSE_BONES) {
      const a = pts[i],
        b = pts[j];
      if (!a || !b) continue;
      arr.set([a.x, a.y, a.z, b.x, b.y, b.z], n);
      n += 6;
    }
    this.lines.geometry.setDrawRange(0, n / 3);
    attr.needsUpdate = true;
  }
}
