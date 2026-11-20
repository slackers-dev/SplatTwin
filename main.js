import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PoseLandmarker, HandLandmarker, FilesetResolver, DrawingUtils } from '@mediapipe/tasks-vision';
import { KalmanPoint } from './kalman.js';
import { Retargeter, LM } from './retarget.js';
import { loadSplatAvatar } from './splat-avatar.js';
import * as stereoMath from './stereo.js';
import { SkeletonEKF } from './ekf.js';

const MODEL_URL = new URLSearchParams(location.search).get('model') || './models/Xbot.glb';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task';
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';

// Die vertikalen Oeffnungswinkel der Kameras werden im Panel eingegeben. Fuer genaue
// Distanzen spaeter durch eine echte Kalibrierung ersetzen (3DRecon 1, OpenCV calibrateCamera).
const CALIB_SECONDS = 12;
const CALIB_KEY = 'cvai-stereo-calib';
const CALIB_JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const STALE_MS = 200; // aelter darf das Bild der zweiten Kamera nicht sein
const MIN_VISIBILITY = 0.5;
const LOST_TIMEOUT_FRAMES = 30; // danach gilt ein Gelenk als unbekannt (Ruhepose)
const HAND_TIMEOUT_FRAMES = 15; // so lange laeuft eine verlorene Hand per Vorhersage weiter

const $ = (id) => document.getElementById(id);
const ui = {
  status: $('status'), video: $('video'), overlay: $('overlay'),
  kalman: $('kalman'), sigmaA: $('sigmaA'), sigmaZ: $('sigmaZ'),
  debug: $('debug'), move: $('move'), mirror: $('mirror'),
  fingers: $('fingers'), camera: $('camera'), splat: $('splat'),
  videoB: $('videoB'), overlayB: $('overlayB'), cameraB: $('cameraB'), camBBox: $('camBBox'),
  fovA: $('fovA'), fovB: $('fovB'), stereoStatus: $('stereoStatus'),
};

// ---------------------------------------------------------------- Szene
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

// Platzhalter-Raum, wird spaeter durch den Gaussian Splat ersetzt.
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

// ---------------------------------------------------------------- Debug-Skelett
const BONES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [27, 31], [24, 26], [26, 28], [28, 32], [7, 0], [8, 0],
];

function makeSkeleton(color) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BONES.length * 6), 3));
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color }));
  lines.frustumCulled = false;
  lines.position.set(1.1, 1, 0);
  scene.add(lines);
  return lines;
}

function updateSkeleton(lines, pts) {
  const arr = lines.geometry.attributes.position.array;
  let n = 0;
  for (const [i, j] of BONES) {
    const a = pts[i], b = pts[j];
    if (!a || !b) continue;
    arr.set([a.x, a.y, a.z, b.x, b.y, b.z], n);
    n += 6;
  }
  lines.geometry.setDrawRange(0, n / 3);
  lines.geometry.attributes.position.needsUpdate = true;
}

const skelRaw = makeSkeleton(0xe5625e);
const skelFiltered = makeSkeleton(0x6cc4a1);

// ---------------------------------------------------------------- Zustand
let retargeter = null;
let landmarker = null;
let handLandmarker = null;
let landmarkerB = null;
const camB = { lastTime: -1, stamp: -Infinity, world: null, img: null };
let stereo = null;       // { R, T, rms, baseline } nach der Kalibrierung
let collecting = null;   // { start, frames } waehrend der Kalibrierung
let lastMode = 'mono';

// Kamera-Fusion: ein Extended Kalman Filter pro Gelenk, den beide Kameras korrigieren.
const ekf = new SkeletonEKF(33);
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
// Aufnahmezeitpunkt des aktuellen Bildes je Kamera, damit der Filter die Bilder
// zeitlich richtig einordnen kann (die Kameras laufen nicht synchron).
const frameTime = { A: null, B: null };
function watchFrames(video, cam) {
  if (!video.requestVideoFrameCallback) return;
  const onFrame = (now, meta) => {
    // Kameras der Splattwin-App (app-kamera.js) kennen die echte Aufnahmezeit am Geraet.
    frameTime[cam] = video.srcObject?.splattwin?.timeOf(meta, now) ?? meta.captureTime ?? meta.expectedDisplayTime ?? now;
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
}
watchFrames(ui.video, 'A');
watchFrames(ui.videoB, 'B');
const stampOf = (cam, now) => frameTime[cam] ?? now;
let lastVideoTime = -1;
let lastStamp = 0;
let fps = 0;

const filters = Array.from({ length: 33 }, () => new KalmanPoint());
const rootFilter = new KalmanPoint();
let rootOrigin = null;

const SIDES = ['Left', 'Right'];
const handFilters = { Left: makeHandFilters(), Right: makeHandFilters() };
const handMissing = { Left: 0, Right: 0 };
const rawHands = { Left: null, Right: null };
const filteredHands = { Left: null, Right: null };

function makeHandFilters() {
  return Array.from({ length: 21 }, () => new KalmanPoint());
}

const missing = new Array(33).fill(0);
const rawPts = new Array(33).fill(null);
const filteredPts = new Array(33).fill(null);

function status(text) {
  ui.status.textContent = text;
}

// ---------------------------------------------------------------- Tracking
// MediaPipe-Weltkoordinaten (y nach unten, z von der Kamera weg) -> three.js.
const toThree = (l) => [l.x, -l.y, -l.z];

const camToThree = (p) => [p[0], -p[1], -p[2]];
const focalA = () => focalOf('A');
const focalB = () => focalOf('B');
const aspectOf = (v) => v.videoWidth / v.videoHeight;
const okJoint = (world, img, i, min = MIN_VISIBILITY) =>
  !!world && inFrame(img[i]) && (world[i].visibility ?? 1) >= min;

const inFrame = (p) => p.x > -0.02 && p.x < 1.02 && p.y > -0.02 && p.y < 1.02;

// Position der Person vor der Kamera aus dem Lochkamera-Modell:
// Tiefe Z = f * (reale Laenge) / (Laenge im Bild). Als Massstab dienen Rumpfstrecken,
// deren reale Laenge parallel zur Bildebene aus den 3D-Landmarks bekannt ist.
function estimateRoot(img, world, aspect) {
  const idx = [LM.lSh, LM.rSh, LM.lHip, LM.rHip];
  if (idx.some((i) => !inFrame(img[i]) || (img[i].visibility ?? 1) < MIN_VISIBILITY)) return null;
  const pairs = [[LM.lSh, LM.rSh], [LM.lHip, LM.rHip], [LM.lSh, LM.lHip], [LM.rSh, LM.rHip], [LM.lSh, LM.rHip], [LM.rSh, LM.lHip]];
  let metric = 0, pixels = 0;
  for (const [i, j] of pairs) {
    metric += Math.hypot(world[i].x - world[j].x, world[i].y - world[j].y);
    pixels += Math.hypot((img[i].x - img[j].x) * aspect, img[i].y - img[j].y);
  }
  if (pixels < 1e-4) return null;
  const f = focalA();
  const Z = (f * metric) / pixels;
  const u = (img[LM.lHip].x + img[LM.rHip].x) / 2 - 0.5;
  return [(u * aspect * Z) / f, 0, -Z];
}

// Eine Kamera: 3D-Pose direkt aus MediaPipe (Tiefe ist nur geschaetzt).
function measureMono(world, img) {
  const pts = new Array(33).fill(null);
  const vis = new Array(33).fill(0);
  for (let i = 0; i < 33; i++) {
    if (!okJoint(world, img, i)) continue;
    pts[i] = toThree(world[i]);
    vis[i] = world[i].visibility ?? 1;
  }
  return { pts, vis, root: world && img ? estimateRoot(img, world, aspectOf(ui.video)) : null, nTri: 0 };
}

// Zwei Kameras: Gelenke, die beide sehen, werden trianguliert (gemessene Tiefe).
// Gelenke, die nur eine Kamera sieht, kommen aus deren Einzelschaetzung und werden
// an die triangulierten Punkte angehaengt.
function measureStereo(worldA, imgA, worldB, imgB) {
  const { R, T } = stereo;
  const arr = (l) => [l.x, l.y, l.z];
  const monoA = (i) => arr(worldA[i]);
  const monoB = (i) => stereoMath.mulMtV(R, arr(worldB[i]));

  const tri = new Array(33).fill(null);
  let offA = [0, 0, 0], offB = [0, 0, 0], n = 0;
  for (let i = 0; i < 33; i++) {
    if (!okJoint(worldA, imgA, i) || !okJoint(worldB, imgB, i)) continue;
    const X = stereoMath.triangulate(
      normPoint('A', imgA[i]), normPoint('B', imgB[i]), R, T);
    if (!X) continue;
    tri[i] = X;
    offA = stereoMath.add(offA, stereoMath.sub(X, monoA(i)));
    offB = stereoMath.add(offB, stereoMath.sub(X, monoB(i)));
    n++;
  }
  if (n < 4) return null;
  offA = stereoMath.scale(offA, 1 / n); // = Position der Huefte in Kamera A
  offB = stereoMath.scale(offB, 1 / n);

  const pts = new Array(33).fill(null);
  const abs = new Array(33).fill(null); // in Koordinaten von Kamera A, als Startwert fuer den EKF
  const vis = new Array(33).fill(0);
  let nTri = 0;
  for (let i = 0; i < 33; i++) {
    const a = okJoint(worldA, imgA, i), b = okJoint(worldB, imgB, i);
    let P = null;
    if (tri[i]) {
      // Grobe Ausreisser (z.B. links/rechts vertauscht) verwerfen.
      const guess = stereoMath.add(monoA(i), offA);
      if (stereoMath.norm(stereoMath.sub(tri[i], guess)) < 0.4) { P = tri[i]; nTri++; } else P = guess;
    } else if (a) P = stereoMath.add(monoA(i), offA);
    else if (b) P = stereoMath.add(monoB(i), offB);
    if (!P) continue;
    abs[i] = P;
    pts[i] = camToThree(stereoMath.sub(P, offA));
    vis[i] = Math.max(a ? worldA[i].visibility ?? 1 : 0, b ? worldB[i].visibility ?? 1 : 0);
  }
  return { pts, abs, vis, root: [offA[0], 0, -offA[2]], nTri };
}

// Beobachtungen einer Kamera fuer den EKF: entzerrter Bildpunkt und die
// 3D-Einzelschaetzung relativ zur Huefte, ausgedrueckt in den Achsen von Kamera A.
function buildObs(cam, world, img) {
  const obs = new Array(33).fill(null);
  if (!world) return obs;
  for (let i = 0; i < 33; i++) {
    if (!okJoint(world, img, i)) continue;
    const w = [world[i].x, world[i].y, world[i].z];
    obs[i] = {
      n: normPoint(cam, img[i]),
      vis: world[i].visibility ?? 1,
      mono: cam === 'A' ? w : stereoMath.mulMtV(stereo.R, w),
    };
  }
  return obs;
}

// Zweite Kamera: eigene Pose-Erkennung, Ergebnis wird mit Zeitstempel gemerkt.
function trackB(now) {
  const video = ui.videoB;
  if (!landmarkerB || video.readyState < 2 || video.currentTime === camB.lastTime) return;
  camB.lastTime = video.currentTime;
  const result = landmarkerB.detectForVideo(video, now);
  camB.world = result.worldLandmarks?.[0] ?? null;
  camB.img = result.landmarks?.[0] ?? null;
  camB.stamp = now;
  drawOverlay(ui.videoB, ui.overlayB, drawerB, camB.img);
  // Kamera B korrigiert den Filter zu ihrem eigenen Aufnahmezeitpunkt.
  if (stereo && lastMode === 'stereo') {
    ekf.updateCamera(stampOf('B', now), buildObs('B', camB.world, camB.img), stereo.R, stereo.T,
      { sigmaA: +ui.sigmaA.value, sigmaZ: +ui.sigmaZ.value / 100 });
    camB.rejected = ekf.rejected;
  }
}

// Sammelt waehrend der Kalibrierung Gelenke, die beide Kameras sicher sehen.
function collectCalibration(now, worldA, imgA, worldB, imgB) {
  if (worldA && worldB) {
    const frame = { nA: [], nB: [], WA: [], WB: [] };
    for (const i of CALIB_JOINTS) {
      if (!okJoint(worldA, imgA, i, 0.6) || !okJoint(worldB, imgB, i, 0.6)) continue;
      frame.nA.push(normPoint('A', imgA[i]));
      frame.nB.push(normPoint('B', imgB[i]));
      frame.WA.push([worldA[i].x, worldA[i].y, worldA[i].z]);
      frame.WB.push([worldB[i].x, worldB[i].y, worldB[i].z]);
    }
    if (frame.nA.length >= 6) collecting.frames.push(frame);
  }
  const left = CALIB_SECONDS - (now - collecting.start) / 1000;
  if (left > 0) {
    ui.stereoStatus.textContent = `Kalibriere … noch ${left.toFixed(0)} s, ${collecting.frames.length} Aufnahmen. Bewege dich und die Arme.`;
    return;
  }
  const frames = collecting.frames;
  collecting = null;
  try {
    const c = stereoMath.calibrate(frames);
    // Mit Messband gemessener Kameraabstand aus der Splattwin-App: legt den Massstab genauer fest
    // als die Koerperschaetzung. Die Richtung der Verschiebung bleibt, nur ihre Laenge wird ersetzt.
    const measured = window.splattwin?.baseline;
    if (measured > 0 && c.baseline > 0) {
      c.T = stereoMath.scale(c.T, measured / c.baseline);
      c.baseline = measured;
    }
    stereo = { R: c.R, T: c.T, rms: c.rms, baseline: c.baseline, fovA: +ui.fovA.value, fovB: +ui.fovB.value };
    try { localStorage.setItem(CALIB_KEY, JSON.stringify(stereo)); } catch { /* nur Komfort */ }
    showStereo();
  } catch (err) {
    ui.stereoStatus.textContent = 'Kalibrierung fehlgeschlagen: ' + err.message;
  }
}

function showStereo(extra = '') {
  if (!stereo) { ui.stereoStatus.textContent = 'Nicht kalibriert.'; return; }
  const px = stereo.rms * focalA() * (ui.video.videoHeight || 720);
  ui.stereoStatus.textContent =
    `Kalibriert · Kameraabstand ${stereo.baseline.toFixed(2)} m · Fehler ${px.toFixed(1)} px` + extra;
}

// Ordnet erkannte Haende ueber den Abstand zum Handgelenk der Koerperpose der
// linken oder rechten Seite zu (robuster als das Links/Rechts-Label des Handmodells).
function assignHands(handResult, img) {
  const out = { Left: null, Right: null };
  if (!handResult || !img) return out;
  const wrists = { Left: img[LM.lWr], Right: img[LM.rWr] };
  const candidates = [];
  handResult.landmarks.forEach((lms, h) => {
    for (const side of SIDES) {
      const d = Math.hypot(lms[0].x - wrists[side].x, lms[0].y - wrists[side].y);
      candidates.push({ h, side, d });
    }
  });
  candidates.sort((a, b) => a.d - b.d);
  const usedHands = new Set();
  for (const { h, side, d } of candidates) {
    if (out[side] || usedHands.has(h) || d > 0.15) continue;
    out[side] = handResult.worldLandmarks[h].map(toThree);
    usedHands.add(h);
  }
  return out;
}

function trackHands(now, img, dt, sigmaA, sigmaZ) {
  const active = handLandmarker && ui.fingers.checked;
  const result = active ? handLandmarker.detectForVideo(ui.video, now) : null;
  const measured = assignHands(result, img);
  for (const side of SIDES) {
    const z = measured[side];
    handMissing[side] = z ? 0 : handMissing[side] + 1;
    if (!active || handMissing[side] > HAND_TIMEOUT_FRAMES) {
      handFilters[side].forEach((f) => f.reset());
      rawHands[side] = filteredHands[side] = null;
      continue;
    }
    rawHands[side] = z ? z.map((p) => new THREE.Vector3(...p)) : null;
    // Finger sind klein: Messrauschen entsprechend kleiner ansetzen.
    const pts = handFilters[side].map((f, i) => f.step(z ? z[i] : null, dt, sigmaA, sigmaZ * 0.3));
    filteredHands[side] = pts[0] ? pts.map((p) => new THREE.Vector3(...p)) : null;
  }
  return result?.landmarks ?? [];
}

function track(now) {
  trackB(now);
  const video = ui.video;
  if (!landmarker || video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  const dt = lastStamp ? Math.min((now - lastStamp) / 1000, 0.1) : 1 / 30;
  if (lastStamp) fps += (1 / dt - fps) * 0.1;
  lastStamp = now;

  const result = landmarker.detectForVideo(video, now);
  const world = result.worldLandmarks?.[0];
  const img = result.landmarks?.[0];

  const sigmaA = +ui.sigmaA.value;
  const sigmaZ = +ui.sigmaZ.value / 100;
  const handsImg = trackHands(now, img, dt, sigmaA, sigmaZ);
  drawOverlay(ui.video, ui.overlay, drawer, img, handsImg);

  const bFresh = now - camB.stamp < STALE_MS;
  if (collecting) collectCalibration(now, world, img, bFresh ? camB.world : null, camB.img);

  // Gelenke ausserhalb des Bildes raet das Modell nur: nicht als Messung verwenden.
  let m = null;
  if (stereo && world && bFresh && camB.world) m = measureStereo(world, img, camB.world, camB.img);
  const mode = m ? 'stereo' : 'mono';
  if (!m) m = measureMono(world, img);
  if (mode !== lastMode) {
    // Die Positionen beider Verfahren sind nicht deckungsgleich: neu einmitten.
    lastMode = mode;
    rootOrigin = null;
    rootFilter.reset();
    ekf.reset();
  }

  // Zwei Kameras: Kamera A korrigiert den EKF, unbekannte Gelenke starten bei der Triangulation.
  let fused = null, fusedRoot = null, rejected = 0;
  if (mode === 'stereo') {
    ekf.updateCamera(stampOf('A', now), buildObs('A', world, img), IDENTITY, [0, 0, 0],
      { sigmaA, sigmaZ, init: (i) => m.abs[i] });
    rejected = ekf.rejected + (camB.rejected ?? 0);
    fused = ekf.positions();
    const l = fused[LM.lHip], r = fused[LM.rHip];
    fusedRoot = l && r ? stereoMath.scale(stereoMath.add(l, r), 0.5) : ekf.offset;
  }

  for (let i = 0; i < 33; i++) {
    const z = m.pts[i];
    const vis = m.vis[i];
    rawPts[i] = z ? new THREE.Vector3(...z) : null;
    if (fused) {
      const p = fused[i] && fusedRoot ? camToThree(stereoMath.sub(fused[i], fusedRoot)) : null;
      filteredPts[i] = p ? new THREE.Vector3(...p) : null;
      continue;
    }
    missing[i] = z ? 0 : missing[i] + 1;
    if (missing[i] > LOST_TIMEOUT_FRAMES) filters[i].reset();
    // Unsichere Messungen bekommen ein groesseres Messrauschen.
    const p = filters[i].step(z, dt, sigmaA, sigmaZ / Math.max(vis, 0.1));
    filteredPts[i] = p ? new THREE.Vector3(...p) : null;
  }

  const rootZ = m.root;
  if (rootZ && !rootOrigin) rootOrigin = rootZ.slice();
  const root = fused
    ? (fusedRoot ? [fusedRoot[0], 0, -fusedRoot[2]] : null)
    : rootFilter.step(rootZ, dt, sigmaA / 4, sigmaZ * 3);

  if (retargeter) {
    const useFilter = ui.kalman.checked;
    retargeter.apply(useFilter ? filteredPts : rawPts, useFilter ? filteredHands : rawHands);
    const r = useFilter ? root : rootZ;
    if (ui.move.checked && r && rootOrigin) {
      retargeter.model.position.x = r[0] - rootOrigin[0];
      retargeter.model.position.z = r[2] - rootOrigin[2];
    } else if (!ui.move.checked) {
      retargeter.model.position.x = retargeter.model.position.z = 0;
    }
  }

  updateSkeleton(skelRaw, rawPts);
  updateSkeleton(skelFiltered, filteredPts);
  status(world
    ? `Person erkannt · ${fps.toFixed(0)} fps` + (rootZ ? ` · Distanz ${(-rootZ[2]).toFixed(2)} m` : '')
      + (mode === 'stereo'
        ? ` · Stereo: ${m.nTri} Gelenke trianguliert · EKF: ${fused.filter(Boolean).length} Gelenke, ${rejected} Messungen verworfen`
        : ' · eine Kamera')
    : `Keine Person im Bild · ${fps.toFixed(0)} fps`);
}

// ---------------------------------------------------------------- Vorschau
const drawer = new DrawingUtils(ui.overlay.getContext('2d'));
const drawerB = new DrawingUtils(ui.overlayB.getContext('2d'));

function drawOverlay(video, overlay, drawer, landmarks, hands = []) {
  if (overlay.width !== video.videoWidth) {
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
  }
  overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
  if (!landmarks) return;
  drawer.drawConnectors(landmarks, PoseLandmarker.POSE_CONNECTIONS, { color: '#6cc4a1', lineWidth: 3 });
  drawer.drawLandmarks(landmarks, { color: '#e5625e', radius: 3 });
  for (const hand of hands) {
    drawer.drawConnectors(hand, HandLandmarker.HAND_CONNECTIONS, { color: '#f2c14e', lineWidth: 2 });
  }
}

// ---------------------------------------------------------------- Quellen
function resetTracking() {
  lastVideoTime = -1;
  lastStamp = 0;
  rootOrigin = null;
  rootFilter.reset();
  filters.forEach((f) => f.reset());
  SIDES.forEach((s) => handFilters[s].forEach((f) => f.reset()));
}

// Liste der Kameras (ein iPhone erscheint am Mac ueber Continuity Camera automatisch).
async function listCameras(activeId) {
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  ui.camera.replaceChildren(...cams.map((c, i) => new Option(c.label || `Kamera ${i + 1}`, c.deviceId)));
  ui.camera.value = activeId ?? '';
  ui.camera.hidden = cams.length < 2;
  const previousB = ui.cameraB.value;
  ui.cameraB.replaceChildren(...cams.map((c, i) => new Option(c.label || `Kamera ${i + 1}`, c.deviceId)));
  const other = cams.find((c) => c.deviceId !== activeId);
  ui.cameraB.value = cams.some((c) => c.deviceId === previousB) && previousB !== activeId ? previousB : other?.deviceId ?? '';
  ui.cameraB.hidden = cams.length < 2;
}

// Kameras, die erst spaeter auftauchen (z.B. das iPhone), in die Listen aufnehmen.
navigator.mediaDevices?.addEventListener('devicechange', () => {
  const active = ui.video.srcObject?.getVideoTracks()[0]?.getSettings().deviceId;
  if (active) listCameras(active);
});

function showCamB() {
  ui.camBBox.hidden = false;
  camB.lastTime = -1;
  camB.stamp = -Infinity;
}

async function startCameraB(deviceId) {
  try {
    if (!deviceId) {
      // Kameranamen gibt der Browser erst nach der Freigabe heraus.
      if (!ui.video.srcObject) await startWebcam(ui.camera.value);
      deviceId = ui.cameraB.value;
      if (!deviceId) throw new Error('keine zweite Kamera gefunden');
    }
    ui.videoB.srcObject?.getTracks().forEach((t) => t.stop());
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720, deviceId: { exact: deviceId } }, audio: false,
    });
    ui.videoB.removeAttribute('src');
    ui.videoB.srcObject = stream;
    await ui.videoB.play();
    showCamB();
    setupZoomB(stream.getVideoTracks()[0]);
    adoptAppCamera('B', stream);
  } catch (err) {
    ui.stereoStatus.textContent = 'Zweite Kamera nicht verfügbar: ' + err.message;
  }
}

// Manche Kameras lassen den Zoom (und damit die Linse) vom Browser aus steuern.
// Ob das iPhone das ueber Continuity Camera anbietet, zeigt sich erst am Geraet.
function setupZoomB(track) {
  const caps = track.getCapabilities?.() ?? {};
  const settings = track.getSettings();
  const row = $('zoomBRow'), slider = $('zoomB');
  $('camBInfo').textContent = `Kamera B: ${settings.width}×${settings.height}`
    + (caps.zoom ? '' : ' · Zoom im Browser nicht steuerbar');
  row.hidden = !caps.zoom;
  if (!caps.zoom) return;
  slider.min = caps.zoom.min;
  slider.max = caps.zoom.max;
  slider.step = caps.zoom.step || 0.1;
  slider.value = settings.zoom ?? caps.zoom.min;
  $('zoomBVal').textContent = (+slider.value).toFixed(1);
  slider.onchange = async () => {
    try {
      await track.applyConstraints({ advanced: [{ zoom: +slider.value }] });
      $('zoomBVal').textContent = (+slider.value).toFixed(1);
      // Anderer Bildausschnitt: die bisherigen Kameradaten gelten nicht mehr.
      if (intrinsics.B) {
        intrinsics.B = null;
        saveIntrinsics();
        showIntrinsics();
      }
      dropStereo();
    } catch (err) {
      $('camBInfo').textContent = 'Zoom konnte nicht gesetzt werden: ' + err.message;
    }
  };
}

async function startVideoB(url) {
  ui.videoB.srcObject?.getTracks().forEach((t) => t.stop());
  ui.videoB.srcObject = null;
  ui.videoB.src = url;
  await ui.videoB.play();
  showCamB();
}

async function startWebcam(deviceId) {
  try {
    ui.video.srcObject?.getTracks().forEach((t) => t.stop());
    const video = { width: 1280, height: 720 };
    if (typeof deviceId === 'string' && deviceId) video.deviceId = { exact: deviceId };
    const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    ui.video.removeAttribute('src');
    ui.video.srcObject = stream;
    await ui.video.play();
    resetTracking();
    adoptAppCamera('A', stream);
    await listCameras(stream.getVideoTracks()[0].getSettings().deviceId);
  } catch (err) {
    status('Webcam nicht verfügbar: ' + err.message);
  }
}

async function startVideo(url) {
  ui.video.srcObject?.getTracks().forEach((t) => t.stop());
  ui.video.srcObject = null;
  ui.video.src = url;
  await ui.video.play();
  resetTracking();
}

$('btnCam').addEventListener('click', () => startWebcam(ui.camera.value));
ui.camera.addEventListener('change', () => startWebcam(ui.camera.value));
$('file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) startVideo(URL.createObjectURL(f));
});
$('btnCamB').addEventListener('click', () => startCameraB(ui.cameraB.value));
ui.cameraB.addEventListener('change', () => { if (!ui.camBBox.hidden) startCameraB(ui.cameraB.value); });
$('btnCalib').addEventListener('click', () => {
  if (ui.camBBox.hidden) { ui.stereoStatus.textContent = 'Zuerst die zweite Kamera starten.'; return; }
  stereo = null;
  collecting = { start: performance.now(), frames: [] };
});
$('btnCalibClear').addEventListener('click', () => {
  stereo = null;
  collecting = null;
  try { localStorage.removeItem(CALIB_KEY); } catch { /* nur Komfort */ }
  showStereo();
});
$('btnCenter').addEventListener('click', () => { rootOrigin = null; });
ui.mirror.addEventListener('change', () => document.body.classList.toggle('mirror', ui.mirror.checked));
ui.debug.addEventListener('change', () => { skelRaw.visible = skelFiltered.visible = ui.debug.checked; });
const showSliders = () => {
  $('sigmaAVal').textContent = (+ui.sigmaA.value).toFixed(1);
  $('sigmaZVal').textContent = (+ui.sigmaZ.value).toFixed(1);
};
ui.sigmaA.addEventListener('input', showSliders);
ui.sigmaZ.addEventListener('input', showSliders);
showSliders();

// ---------------------------------------------------------------- Schachbrett-Kalibrierung
// Kameramatrix und Linsenverzeichnung pro Kamera. Die Bilder gehen an den lokalen
// Server (server.py), der mit OpenCV die Ecken sucht und calibrateCamera rechnet.
const INTR_KEY = 'cvai-intrinsics';
const CHESS_VIEWS = 20;
const intrinsics = { A: null, B: null };
let chess = null; // laufende Aufnahme: { cam, timer, busy, first, canvas }

function videoOf(cam) {
  return cam === 'A' ? ui.video : ui.videoB;
}

// Brennweite in Bildhoehen: gemessen, falls kalibriert, sonst aus dem eingegebenen Winkel.
function focalOf(cam) {
  const fov = +(cam === 'A' ? ui.fovA : ui.fovB).value || 50;
  return intrinsics[cam]?.fy ?? stereoMath.focalFromFov(fov);
}

// MediaPipe-Bildpunkt (0..1) -> normierte, entzerrte Bildkoordinaten.
function normPoint(cam, p) {
  const k = intrinsics[cam];
  if (!k) return stereoMath.normalizePoint(p, aspectOf(videoOf(cam)), focalOf(cam));
  return stereoMath.undistort((p.x - k.cx) / k.fx, (p.y - k.cy) / k.fy, k.dist);
}

function showIntrinsics() {
  const lines = [];
  for (const cam of ['A', 'B']) {
    const k = intrinsics[cam];
    const input = cam === 'A' ? ui.fovA : ui.fovB;
    input.disabled = !!k;
    if (k) input.value = k.fovY.toFixed(1);
    lines.push(k
      ? `${cam}: ${k.fovX.toFixed(0)}° × ${k.fovY.toFixed(0)}°, Verzeichnung k1 ${k.dist[0].toFixed(3)}, Fehler ${k.rms.toFixed(2)} px (${k.views} Bilder)`
      : `${cam}: nicht kalibriert, Winkel geschätzt`);
  }
  $('intrStatus').textContent = lines.join('\n');
}

function saveIntrinsics() {
  try { localStorage.setItem(INTR_KEY, JSON.stringify(intrinsics)); } catch { /* nur Komfort */ }
}

// Neue Kameradaten machen die Stereo-Kalibrierung ungueltig.
function dropStereo() {
  if (!stereo) return;
  stereo = null;
  try { localStorage.removeItem(CALIB_KEY); } catch { /* nur Komfort */ }
  ui.stereoStatus.textContent = 'Kameradaten geändert: bitte Stereo neu kalibrieren.';
}

// Kameras der Splattwin-App (app-kamera.js) liefern ihre Kameradaten selbst: Brennweite und
// Bildmittelpunkt vom Geraet, das Bild ist bereits entzerrt. Das ersetzt fuer sie das Schachbrett.
// Wechselt in der App die Linse oder das Format, meldet sich der Stream und die Daten werden erneuert.
function adoptAppCamera(cam, stream) {
  const app = stream.splattwin;
  if (!app) return;
  const use = () => {
    const k = app.intrinsics;
    if (cam === 'B') $('camBInfo').textContent = `Kamera B: ${app.info.width}×${app.info.height} · Linse und Zoom in der Splattwin-App`;
    if (!k || JSON.stringify(k) === JSON.stringify(intrinsics[cam])) return;
    intrinsics[cam] = k;
    saveIntrinsics();
    showIntrinsics();
    dropStereo();
  };
  app.onchange = use;
  use();
}

function stopChess(message) {
  if (!chess) return;
  clearInterval(chess.timer);
  chess = null;
  $('chess').hidden = true;
  $('chessVideo').srcObject = null;
  $('chessVideo').removeAttribute('src');
  if (message) $('intrStatus').textContent = message;
}

function startChess(cam) {
  const video = videoOf(cam);
  if (video.readyState < 2) {
    $('intrStatus').textContent = `Zuerst Kamera ${cam} starten.`;
    return;
  }
  // Kamera B filmt das Brett auf diesem Bildschirm. Kamera A sieht den eigenen
  // Bildschirm nicht: dort das Brett auf dem Handy zeigen und im Livebild kontrollieren.
  const board = $('board'), view = $('chessVideo');
  board.hidden = cam === 'A';
  view.hidden = false;
  view.classList.toggle('mini', cam === 'B'); // bei B nur als kleine Kontrollansicht in der Ecke
  if (video.srcObject) view.srcObject = video.srcObject; else view.src = video.currentSrc;
  view.play();
  $('chessInfo').textContent = cam === 'A'
    ? 'Kamera A: Schachbrett (schachbrett.png) auf dem Handy anzeigen und vor die Kamera halten.'
    : 'Kamera B: Mit dem iPhone dieses Schachbrett filmen. Unten rechts siehst du, was das iPhone sieht.';
  const ctx = $('coverage').getContext('2d');
  ctx.clearRect(0, 0, 352, 198);
  $('chess').hidden = false;
  chess = { cam, busy: false, first: true, canvas: document.createElement('canvas'), timer: setInterval(chessTick, 600) };
}

async function chessPost(path, body) {
  const res = await fetch(path, { method: 'POST', body });
  const data = await res.json().catch(() => null);
  if (!data) throw new Error('Server ohne Kalibrierung. Bitte mit server.py starten.');
  if (!res.ok) throw new Error(data.error || 'Serverfehler ' + res.status);
  return data;
}

async function chessTick() {
  if (!chess || chess.busy) return;
  const run = chess;
  run.busy = true;
  try {
    const video = videoOf(run.cam);
    run.canvas.width = video.videoWidth;
    run.canvas.height = video.videoHeight;
    run.canvas.getContext('2d').drawImage(video, 0, 0);
    const blob = await new Promise((resolve) => run.canvas.toBlob(resolve, 'image/jpeg', 0.92));
    const d = await chessPost(`/api/chessboard?cam=${run.cam}${run.first ? '&reset=1' : ''}`, blob);
    run.first = false;
    if (chess !== run) return;
    if (d.corners) {
      const ctx = $('coverage').getContext('2d');
      ctx.fillStyle = '#2a9d6f';
      for (const [x, y] of d.corners) ctx.fillRect(x * 352 - 1.5, y * 198 - 1.5, 3, 3);
    }
    const hint = !d.found ? 'Brett nicht erkannt' : d.accepted ? 'übernommen' : 'erkannt, bitte weiterbewegen';
    $('chessInfo').textContent = `Kamera ${run.cam}: ${d.count} / ${CHESS_VIEWS} Ansichten · ${hint}. `
      + 'Brett aus verschiedenen Winkeln und Abständen zeigen, auch am Bildrand und in den Ecken (kleines Feld unten links).';
    if (d.count >= CHESS_VIEWS) {
      clearInterval(run.timer);
      $('chessInfo').textContent = 'Rechne …';
      intrinsics[run.cam] = await chessPost(`/api/calibrate?cam=${run.cam}`);
      saveIntrinsics();
      dropStereo();
      stopChess();
      showIntrinsics();
    }
  } catch (err) {
    stopChess('Kalibrierung abgebrochen: ' + err.message);
  } finally {
    run.busy = false;
  }
}

$('board').replaceChildren(...Array.from({ length: 70 }, (_, i) => {
  const cell = document.createElement('i');
  if ((Math.floor(i / 10) + i) % 2) cell.className = 'w';
  return cell;
}));
$('btnChessA').addEventListener('click', () => startChess('A'));
$('btnChessB').addEventListener('click', () => startChess('B'));
$('btnChessCancel').addEventListener('click', () => stopChess('Kalibrierung abgebrochen.'));
$('btnChessClear').addEventListener('click', () => {
  intrinsics.A = intrinsics.B = null;
  try { localStorage.removeItem(INTR_KEY); } catch { /* nur Komfort */ }
  dropStereo();
  showIntrinsics();
});
try {
  const saved = JSON.parse(localStorage.getItem(INTR_KEY) || 'null');
  for (const cam of ['A', 'B']) if (saved?.[cam]?.dist?.length === 5) intrinsics[cam] = saved[cam];
} catch { /* nur Komfort */ }
showIntrinsics();

// ---------------------------------------------------------------- Start
async function loadAvatar() {
  const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
  const model = gltf.scene;
  model.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; }
  });
  scene.add(model);
  retargeter = new Retargeter(model);
}

async function loadPose() {
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  landmarker = await PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numPoses: 1,
  });
  // Eigene Instanz fuer Kamera B: im Video-Modus merkt sich das Modell den Verlauf.
  landmarkerB = await PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numPoses: 1,
  });
  handLandmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numHands: 2,
  });
}

renderer.setAnimationLoop((now) => {
  try {
    track(now);
  } catch (err) {
    console.error(err);
    status('Fehler: ' + err.message);
  }
  controls.update();
  renderer.render(scene, camera);
});

try {
  await Promise.all([loadAvatar(), loadPose()]);
  status('Bereit. Webcam starten oder Video laden.');
  // Gespeicherte Kalibrierung gilt nur, solange die Kameras nicht bewegt wurden.
  try {
    const saved = JSON.parse(localStorage.getItem(CALIB_KEY) || 'null');
    if (saved?.R?.length === 9 && saved?.T?.length === 3) {
      stereo = saved;
      ui.fovA.value = saved.fovA ?? ui.fovA.value;
      ui.fovB.value = saved.fovB ?? ui.fovB.value;
      showStereo(' (gespeichert)');
    }
  } catch { /* nur Komfort */ }
  const params = new URLSearchParams(location.search);
  // Gaussian Splat der Person als Avatar (Machbarkeitstest), ?run=<Lauf der Pipeline>.
  try {
    const splat = await loadSplatAvatar(scene, renderer, retargeter, params.get('run') || 'IMG_0706');
    ui.splat.disabled = false;
    ui.splat.checked = true;
    ui.splat.addEventListener('change', () => splat.setVisible(ui.splat.checked));
    splat.setVisible(true);
  } catch (err) {
    console.warn('Splat-Avatar nicht geladen:', err);
  }
  if (params.get('src')) await startVideo(params.get('src'));
  if (params.get('srcB')) await startVideoB(params.get('srcB'));
} catch (err) {
  console.error(err);
  status('Fehler beim Laden: ' + err.message);
}

// Fuer Tests in der Konsole.
window.app = { scene, camera, controls, rawPts, filteredPts, rawHands, filteredHands,
  get stereo() { return stereo; }, set stereo(v) { stereo = v; }, intrinsics, ekf, get retargeter() { return retargeter; } };
