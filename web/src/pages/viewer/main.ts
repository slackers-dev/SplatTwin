// Splat-Viewer: zeigt das Ergebnis eines Laufs der Pipeline, ?run=<lauf> (data/runs/<lauf>/).
import './style.css';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { runUrl } from '../../avatar/splat-avatar';
import { fitToWindow } from '../../avatar/stage';
import type { RunSplat } from '../../contracts';
import { byId, params } from '../../ui/dom';

const run = params().get('run');
const status = byId('status');
const avatarLink = byId<HTMLAnchorElement>('avatarLink');

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);
scene.add(new SparkRenderer({ renderer }));
scene.add(new THREE.GridHelper(4, 8, 0x4a505c, 0x2a2f38));

const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
camera.position.set(0, 1.3, 3.6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.9, 0);
controls.enableDamping = true;
fitToWindow(renderer, camera, true);

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

if (!run) {
  status.textContent = 'Kein Lauf gewählt: viewer.html?run=<lauf> (Ordner in data/runs/)';
} else {
  avatarLink.href = `/tracking.html?run=${encodeURIComponent(run)}`;
  try {
    const base = runUrl(run);
    // splat.json stellt den Splat aufrecht, auf den Boden und auf Koerpergroesse.
    const pose = await fetch(base + 'splat.json').then((r) => (r.ok ? (r.json() as Promise<RunSplat>) : null));
    const splat = new SplatMesh({ url: base + 'splat.ply' });
    if (pose) {
      new THREE.Matrix4()
        .set(...(pose.matrix.flat() as Parameters<THREE.Matrix4['set']>))
        .decompose(splat.position, splat.quaternion, splat.scale);
    }
    scene.add(splat);
    await splat.initialized;
    status.textContent = `${run}${pose ? '' : ' (ohne Ausrichtung)'} · ziehen zum Drehen`;
  } catch (err) {
    status.textContent = `Fehler: ${(err as Error).message}`;
  }
}
