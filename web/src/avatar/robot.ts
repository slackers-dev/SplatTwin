// Der Roboter (Mixamo X Bot): Skelett und Skinning-Gewichte, an die der Splat gehaengt wird.
import type * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { Retargeter } from './retarget';

export const ROBOT_URL = '/models/Xbot.glb';

export async function loadRobot(scene: THREE.Scene, url = ROBOT_URL): Promise<Retargeter> {
  const gltf = await new GLTFLoader().loadAsync(url);
  const model = gltf.scene;
  model.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.frustumCulled = false;
    }
  });
  scene.add(model);
  return new Retargeter(model);
}

/** Roboter einmal laden und dann pro Presenter klonen (Buehne). */
export async function loadRobotTemplate(url = ROBOT_URL): Promise<THREE.Object3D> {
  return (await new GLTFLoader().loadAsync(url)).scene;
}

/** Eigener Roboter mit eigenem Skelett und eigenen Materialien (zum Einfaerben), in parent eingehaengt. */
export function cloneRobot(template: THREE.Object3D, parent: THREE.Object3D): Retargeter {
  const model = cloneSkinned(template);
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => m.clone()) : mesh.material.clone();
  });
  parent.add(model);
  parent.updateMatrixWorld(true);
  return new Retargeter(model);
}
