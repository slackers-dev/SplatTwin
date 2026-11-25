// Punkte aus dem Tracking (Vec3 als Array) als three.js-Vektoren fuer den Avatar.
import * as THREE from 'three';
import type { Vec3 } from '../core/vec';

export type Points = (THREE.Vector3 | null)[];
export type HandPoints = { Left?: Points | null; Right?: Points | null };

export const toVector = (p: Vec3 | null | undefined): THREE.Vector3 | null => (p ? new THREE.Vector3(p[0], p[1], p[2]) : null);

export const toVectors = (pts: readonly (Vec3 | null)[] | null | undefined): Points | null => (pts ? pts.map(toVector) : null);
