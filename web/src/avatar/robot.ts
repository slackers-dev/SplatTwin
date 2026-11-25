// Der Roboter (Mixamo X Bot): Skelett und Skinning-Gewichte, an die der Splat gehaengt wird.
import type * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
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
