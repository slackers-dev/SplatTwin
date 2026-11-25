// Die 3D-Szene, in der der Avatar steht: Renderer, Kamera mit Maussteuerung, Licht, Boden.
// Tracking- und Zuschauerseite benutzen dieselbe Szene.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
}

const BACKGROUND = 0x14161a;

/** Renderer und Kamera folgen der Fenstergroesse. */
export function fitToWindow(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, updateStyle = false): void {
  const resize = () => {
    renderer.setSize(innerWidth, innerHeight, updateStyle);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize);
  resize();
}

/** Raum mit Licht, Schatten und Boden fuer den Avatar. */
export function createStage(canvas: HTMLCanvasElement): Stage {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);
  scene.fog = new THREE.Fog(BACKGROUND, 8, 20);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 1.5, 4.2);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.enableDamping = true;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x30343c, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(2, 5, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4 });
  scene.add(sun);

  // Platzhalter-Raum, spaeter durch einen Gaussian Splat der Umgebung ersetzbar.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardMaterial({ color: 0x1b1e24, roughness: 1 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(40, 40, 0x3a404c, 0x262a32);
  grid.position.y = 0.002;
  scene.add(grid);

  fitToWindow(renderer, camera);
  return { renderer, scene, camera, controls };
}
