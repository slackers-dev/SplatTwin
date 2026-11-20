// Zuschauerseite: zeigt den Avatar, den die Tracking-Seite (index.html, «Live senden») bewegt.
//
// Keine Kamera und keine Erkennung: Die Seite empfaengt pro Bild die Gelenkpunkte von
// server.py (/api/live, Server-Sent Events) und gibt sie demselben Retargeter wie die
// Tracking-Seite. Laeuft auch auf Handy oder Tablet im selben WLAN (server.py --lan).
//
// ?run=<Lauf> waehlt den Splat; ohne Angabe wird der Lauf der Tracking-Seite genommen.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Retargeter } from './retarget.js';
import { loadSplatAvatar } from './splat-avatar.js';

const params = new URLSearchParams(location.search);
const MODEL_URL = './models/Xbot.glb';
const STALE_MS = 1500; // so lange ohne Bild gilt der Tracker als pausiert

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const setStatus = (text, ok = false) => { statusEl.textContent = text; statusEl.classList.toggle('ok', ok); };

// ---------------------------------------------------------------- Szene (wie index.html)
const renderer = new THREE.WebGLRenderer({ canvas: $('scene'), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);
scene.fog = new THREE.Fog(0x14161a, 8, 20);

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

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

// ---------------------------------------------------------------- Empfang
const toVec = (p) => (p ? new THREE.Vector3(p[0], p[1], p[2]) : null);
let retargeter = null;
let latest = null;      // letztes empfangenes Bild, wird pro Animationsbild einmal angewendet
let lastTime = 0;
let frames = 0, fps = 0, fpsStart = performance.now();

function applyFrame(f) {
  retargeter.upperBodyOnly = !!f.upper;
  retargeter.apply(f.pts.map(toVec), { Left: f.hands?.Left?.map(toVec) ?? null, Right: f.hands?.Right?.map(toVec) ?? null });
  retargeter.model.position.x = f.pos?.[0] ?? 0;
  retargeter.model.position.z = f.pos?.[1] ?? 0;
  document.body.classList.toggle('mirror', !!f.mirror);
}

// Der erste Frame verraet den Lauf der Tracking-Seite, falls ?run fehlt.
function firstFrame() {
  return new Promise((resolve) => {
    const source = new EventSource('/api/live');
    source.onmessage = (e) => {
      latest = JSON.parse(e.data);
      lastTime = performance.now();
      frames++;
      resolve(latest);
    };
    source.onerror = () => setStatus('Verbindung zum Server unterbrochen, versuche es weiter …');
  });
}

try {
  const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
  const model = gltf.scene;
  model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
  scene.add(model);
  retargeter = new Retargeter(model);

  setStatus('warte auf die Tracking-Seite («Live senden» einschalten) …');
  const receiving = firstFrame();
  const run = params.get('run') || (await receiving).run;

  try {
    setStatus(`lade Splat ${run} …`);
    const splat = await loadSplatAvatar(scene, renderer, retargeter, run);
    const box = $('splat');
    box.disabled = false;
    box.addEventListener('change', () => splat.setVisible(box.checked));
    splat.setVisible(true);
  } catch (err) {
    console.warn('Splat nicht geladen, zeige den Roboter:', err);
  }

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    if (latest) { applyFrame(latest); latest = null; }
    if (now - fpsStart > 1000) { fps = (frames * 1000) / (now - fpsStart); frames = 0; fpsStart = now; }
    if (now - lastTime > STALE_MS) setStatus('Tracking pausiert, warte auf neue Bilder …');
    else setStatus(`live · ${fps.toFixed(0)} Bilder/s`, true);
    controls.update();
    renderer.render(scene, camera);
  });
} catch (err) {
  console.error(err);
  setStatus('Fehler beim Laden: ' + err.message);
}
