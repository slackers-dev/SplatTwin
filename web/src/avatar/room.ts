// Raum der Buehne: Boden, Waende, Buehne mit Leuchtkante, Stuhlreihen und Leinwand fuer die Folien,
// dazu Kamera-Ansichten mit weicher Fahrt und eine einfache Qualitaetsstufe fuer Handys.
//
// Koordinaten wie im Avatar: Das Publikum sitzt bei +z und schaut nach -z, die Leinwand haengt an der
// Rueckwand. Platz A steht links (-x, vom Publikum aus), Platz B rechts.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Slot } from '../live/protocol';

export const STAGE_Y = 0.3; // Hoehe der Buehne
export const STAGE_Z = -1.6; // Mitte der Buehne
export const SEATS: Record<Slot, { x: number; color: number; css: string }> = {
  A: { x: -3.5, color: 0x3fb68b, css: '#3fb68b' },
  B: { x: 3.5, color: 0x6b7cf2, css: '#6b7cf2' },
};
/** Standort eines Presenters (Mitte seines Rings) */
export const seatPosition = (slot: Slot): THREE.Vector3 => new THREE.Vector3(SEATS[slot].x, STAGE_Y, STAGE_Z + 0.4);

const BACKGROUND = 0x101216;
const SCREEN_Z = -3.3;
const SCREEN_BOTTOM = 1.05;
const SCREEN_MAX = { w: 5.6, h: 3.1 };

export type ViewName = 'publikum' | 'buehne' | 'folie' | Slot;

export interface Room {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  /** Canvas der Leinwand: hineinzeichnen, dann screenChanged(Seitenverhaeltnis) */
  screenCanvas: HTMLCanvasElement;
  screenChanged(aspect: number): void;
  /** Kamera zu einer Ansicht fahren; target liefert fuer A und B den aktuellen Standort */
  setView(name: ViewName, instant?: boolean): void;
  readonly view: ViewName;
  /** pro Bild: Kamerafahrt, Steuerung, Qualitaet messen, zeichnen */
  frame(now: number): void;
  readonly low: boolean;
}

export interface RoomOptions {
  /** Handy oder schwacher Rechner: ohne Schatten, einfache Aufloesung */
  low: boolean;
  /** Bildrate in den ersten Sekunden messen und bei unter 30 auf die einfache Stufe wechseln */
  autoLow: boolean;
  /** Standort eines Presenters fuer die Ansichten A und B */
  presenterAt(slot: Slot): THREE.Vector3;
}

export function createRoom(canvas: HTMLCanvasElement, opts: RoomOptions): Room {
  let low = opts.low;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !low, powerPreference: 'high-performance' });
  renderer.setPixelRatio(low ? 1 : Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = !low;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);
  scene.fog = new THREE.Fog(BACKGROUND, 12, 26);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 1;
  controls.maxDistance = 16;

  scene.add(new THREE.HemisphereLight(0xcfd6e6, 0x1a1c22, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 0.6);
  key.position.set(1, 7, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -7, right: 7, top: 5, bottom: -5, near: 1, far: 20 });
  scene.add(key);

  const mat = (color: number, roughness = 0.9) => new THREE.MeshStandardMaterial({ color, roughness });
  const box = (w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    m.position.set(x, y, z);
    m.receiveShadow = true;
    scene.add(m);
    return m;
  };

  // Boden, Waende, Buehne
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(16, 18), mat(0x15171c));
  floor.rotation.x = -Math.PI / 2;
  floor.position.z = 2;
  floor.receiveShadow = true;
  scene.add(floor);
  box(16, 6.5, 0.2, mat(0x1a1d23), 0, 3.25, -3.5);
  box(0.2, 6.5, 18, mat(0x17191e), -8, 3.25, 2);
  box(0.2, 6.5, 18, mat(0x17191e), 8, 3.25, 2);
  box(10.5, STAGE_Y, 3.8, mat(0x22252c, 0.6), 0, STAGE_Y / 2, STAGE_Z);
  // Leuchtkante vorne an der Buehne, links mint, rechts blau
  for (const s of Object.values(SEATS)) {
    box(5.25, 0.025, 0.025, new THREE.MeshBasicMaterial({ color: s.color }), Math.sign(s.x) * 2.625, STAGE_Y - 0.02, STAGE_Z + 1.91).receiveShadow = false;
  }

  // Publikum: Stuhlreihen mit Mittelgang
  const seats: [number, number][] = [];
  for (let row = 0; row < 6; row++) {
    for (let x = -5.4; x <= 5.41; x += 0.9) if (Math.abs(x) >= 0.6) seats.push([x, 2.6 + row * 1.15]);
  }
  const seatMat = mat(0x262a33);
  const seatMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.6, 0.08, 0.5), seatMat, seats.length);
  const backMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.6, 0.5, 0.06), seatMat, seats.length);
  const m4 = new THREE.Matrix4();
  seats.forEach(([x, z], i) => {
    seatMesh.setMatrixAt(i, m4.makeTranslation(x, 0.45, z));
    backMesh.setMatrixAt(i, m4.makeTranslation(x, 0.72, z + 0.25));
  });
  for (const mesh of [seatMesh, backMesh]) {
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  // Leinwand: Canvas als Textur, Rahmen, etwas Licht auf Buehne und Presenter
  const screenCanvas = document.createElement('canvas');
  const texture = new THREE.CanvasTexture(screenCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
  const frameMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.06), mat(0x0b0c0f, 0.4));
  scene.add(frameMesh, screen);
  const glow = new THREE.PointLight(0xbfd0ff, 0.6, 9, 1.5);
  scene.add(glow);
  const screenBox = { w: SCREEN_MAX.w, h: SCREEN_MAX.h, cy: 2.6 };

  const screenChanged = (aspect: number) => {
    let h = SCREEN_MAX.h,
      w = h * aspect;
    if (w > SCREEN_MAX.w) {
      w = SCREEN_MAX.w;
      h = w / aspect;
    }
    const cy = SCREEN_BOTTOM + h / 2 + 0.2;
    screen.scale.set(w, h, 1);
    screen.position.set(0, cy, SCREEN_Z + 0.035);
    frameMesh.scale.set(w + 0.14, h + 0.14, 1);
    frameMesh.position.set(0, cy, SCREEN_Z);
    glow.position.set(0, cy, SCREEN_Z + 1.2);
    Object.assign(screenBox, { w, h, cy });
    // three.js legt den Texturspeicher fest an: bei neuer Canvas-Groesse neu anlegen statt nur aktualisieren.
    texture.dispose();
    texture.needsUpdate = true;
    if (view === 'folie') setView('folie');
  };

  // ---------------------------------------------------------------- Ansichten
  // Kamera so weit zurueck, dass ein Bereich (Breite w, Hoehe h) um target ganz ins Bild passt.
  const fit = (target: THREE.Vector3, w: number, h: number, dir: THREE.Vector3) => {
    const t = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const d = Math.max(h / 2 / t, w / 2 / (t * camera.aspect)) * 1.08;
    return { pos: target.clone().addScaledVector(dir.normalize(), d), target };
  };
  const views: Record<ViewName, () => { pos: THREE.Vector3; target: THREE.Vector3 }> = {
    publikum: () => fit(new THREE.Vector3(0, 1.9, -1.8), 11.5, 5.2, new THREE.Vector3(0, 0.16, 1)),
    buehne: () => fit(new THREE.Vector3(0, 1.5, STAGE_Z), 8.6, 2.6, new THREE.Vector3(0, 0.12, 1)),
    folie: () => fit(new THREE.Vector3(0, screenBox.cy, SCREEN_Z), screenBox.w, screenBox.h, new THREE.Vector3(0, 0, 1)),
    A: () => fit(opts.presenterAt('A').setY(STAGE_Y + 1.05), 1.6, 2.3, new THREE.Vector3(0.35, 0.1, 1)),
    B: () => fit(opts.presenterAt('B').setY(STAGE_Y + 1.05), 1.6, 2.3, new THREE.Vector3(-0.35, 0.1, 1)),
  };
  let view: ViewName = 'publikum';
  let flight: { t0: number; from: THREE.Vector3; fromT: THREE.Vector3; goal: { pos: THREE.Vector3; target: THREE.Vector3 } } | null = null;

  const setView = (name: ViewName, instant = false) => {
    view = name;
    const goal = views[name]();
    if (instant) {
      camera.position.copy(goal.pos);
      controls.target.copy(goal.target);
      flight = null;
      return;
    }
    flight = { t0: performance.now(), from: camera.position.clone(), fromT: controls.target.clone(), goal };
  };
  controls.addEventListener('start', () => (flight = null)); // Maus uebernimmt

  const resize = () => {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', () => {
    resize();
    setView(view, true);
  });
  resize();
  setView('publikum', true);

  // ---------------------------------------------------------------- Qualitaet
  const perf = { start: 0, frames: 0, done: !opts.autoLow || low };
  const goLow = () => {
    low = true;
    renderer.setPixelRatio(1);
    renderer.shadowMap.enabled = false;
    scene.traverse((o) => {
      for (const m of ([] as THREE.Material[]).concat((o as THREE.Mesh).material ?? [])) m.needsUpdate = true;
    });
    resize();
  };
  const measure = (now: number) => {
    if (perf.done) return;
    if (!perf.start) perf.start = now + 2000; // erst nach dem Laden messen
    else if (now > perf.start) {
      perf.frames++;
      if (now - perf.start > 4000) {
        perf.done = true;
        if ((perf.frames * 1000) / (now - perf.start) < 30) goLow();
      }
    }
  };

  return {
    renderer,
    scene,
    camera,
    controls,
    screenCanvas,
    screenChanged,
    setView,
    get view() {
      return view;
    },
    get low() {
      return low;
    },
    frame(now: number) {
      measure(now);
      if (flight) {
        const k = Math.min(1, (now - flight.t0) / 900);
        const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        camera.position.lerpVectors(flight.from, flight.goal.pos, e);
        controls.target.lerpVectors(flight.fromT, flight.goal.target, e);
        if (k === 1) flight = null;
      }
      controls.update();
      renderer.render(scene, camera);
    },
  };
}
