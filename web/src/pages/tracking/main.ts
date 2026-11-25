// Tracking-Seite (Live-Avatar): Kamera(s) -> Tracking -> Roboter oder Splat der Person.
//
// Die Seite verdrahtet nur: Bedienelemente, Tracker (src/tracking), Avatar (src/avatar) und
// Live-Senden (src/live). Die Rechnungen stehen in src/core.
//
// Adresse: ?run=<lauf> Splat aus data/runs, ?src=<video> und ?srcB=<video> statt Kameras,
// ?upper nur Oberkoerper, ?ghost=<0..100> Roboter unter dem Splat, ?parts Koerperteile einfaerben,
// ?model=<glb> anderes Modell.
import './style.css';
import { toVectors } from '../../avatar/points';
import { loadRobot, ROBOT_URL } from '../../avatar/robot';
import type { Retargeter } from '../../avatar/retarget';
import { DebugSkeleton } from '../../avatar/skeleton';
import { loadSplatAvatar } from '../../avatar/splat-avatar';
import { createStage } from '../../avatar/stage';
import type { Intrinsics } from '../../contracts';
import type { Slot } from '../../live/protocol';
import { fetchLiveInfo, LiveSender } from '../../live/sender';
import { appStream, bridgeBaseline, installAppBridge } from '../../tracking/app-bridge';
import { type CamId, CAMS, CameraSetup } from '../../tracking/cameras';
import { createHandLandmarker, createPoseLandmarker } from '../../tracking/detectors';
import { Overlay } from '../../tracking/overlay';
import { clearStereo, loadStereo, type SavedStereo, saveStereo } from '../../tracking/stereo-store';
import { type TrackFrame, Tracker, type TrackSettings } from '../../tracking/tracker';
import { deviceIdOf, listVideoInputs, openCamera, openFile } from '../../tracking/video';
import { byId, params } from '../../ui/dom';
import { loadJson, saveJson } from '../../ui/storage';
import { ChessboardCalibration } from './chessboard';

// Kameras der Splattwin-App (app/) als normale Kameras anbieten; ohne laufende App ohne Wirkung.
installAppBridge();

const query = params();
const RUN = query.get('run') ?? ''; // Lauf der Splat-Pipeline
const MODEL_URL = query.get('model') ?? ROBOT_URL;

const input = (id: string) => byId<HTMLInputElement>(id);
const ui = {
  status: byId('status'),
  video: byId<HTMLVideoElement>('video'),
  videoB: byId<HTMLVideoElement>('videoB'),
  kalman: input('kalman'),
  sigmaA: input('sigmaA'),
  sigmaZ: input('sigmaZ'),
  debug: input('debug'),
  move: input('move'),
  upper: input('upper'),
  mirror: input('mirror'),
  fingers: input('fingers'),
  camera: byId<HTMLSelectElement>('camera'),
  cameraB: byId<HTMLSelectElement>('cameraB'),
  camBBox: byId('camBBox'),
  camBInfo: byId('camBInfo'),
  splat: input('splat'),
  live: input('live'),
  liveInfo: byId('liveInfo'),
  liveLinks: byId('liveLinks'),
  liveSlot: byId<HTMLSelectElement>('liveSlot'),
  liveName: input('liveName'),
  liveLite: input('liveLite'),
  fov: { A: input('fovA'), B: input('fovB') } as Record<CamId, HTMLInputElement>,
  stereoStatus: byId('stereoStatus'),
  intrStatus: byId('intrStatus'),
};
const status = (text: string) => (ui.status.textContent = text);

// ---------------------------------------------------------------- Szene und Avatar
const { renderer, scene, camera, controls } = createStage(byId<HTMLCanvasElement>('scene'));
const skelRaw = new DebugSkeleton(scene, 0xe5625e);
const skelFiltered = new DebugSkeleton(scene, 0x6cc4a1);
let retargeter: Retargeter | null = null;

// ---------------------------------------------------------------- Kameras und Kalibrierung
const videos: Record<CamId, HTMLVideoElement> = { A: ui.video, B: ui.videoB };
const cameras = new CameraSetup(videos);
const readFov = () => CAMS.forEach((cam) => (cameras.fov[cam] = +ui.fov[cam].value || 50));
CAMS.forEach((cam) => ui.fov[cam].addEventListener('input', readFov));
readFov();

let stereo: SavedStereo | null = null; // gespeicherte Stereo-Kalibrierung mit Kennzahlen
let tracker: Tracker | null = null;

function showStereo(extra = ''): void {
  if (!stereo) {
    ui.stereoStatus.textContent = 'Nicht kalibriert.';
    return;
  }
  const px = stereo.rms * cameras.focal('A') * (ui.video.videoHeight || 720);
  ui.stereoStatus.textContent = `Kalibriert · Kameraabstand ${stereo.baseline.toFixed(2)} m · Fehler ${px.toFixed(1)} px` + extra;
}

function setStereo(s: SavedStereo | null): void {
  stereo = s;
  if (tracker) tracker.stereo = s ? { R: s.R, T: s.T } : null;
}

/** Neue Kameradaten machen die Stereo-Kalibrierung ungueltig. */
function dropStereo(): void {
  if (!stereo) return;
  setStereo(null);
  clearStereo();
  ui.stereoStatus.textContent = 'Kameradaten geändert: bitte Stereo neu kalibrieren.';
}

function showIntrinsics(): void {
  ui.intrStatus.textContent = CAMS.map((cam) => {
    const k = cameras.intrinsics[cam];
    const fov = ui.fov[cam];
    fov.disabled = !!k;
    if (k) fov.value = k.fovY.toFixed(1);
    return k
      ? `${cam}: ${k.fovX.toFixed(0)}° × ${k.fovY.toFixed(0)}°, Verzeichnung k1 ${k.dist[0].toFixed(3)}, ` +
          `Fehler ${(k.rms ?? 0).toFixed(2)} px (${k.views ?? 0} Bilder)`
      : `${cam}: nicht kalibriert, Winkel geschätzt`;
  }).join('\n');
  readFov();
}

function setIntrinsics(cam: CamId, k: Intrinsics | null): void {
  cameras.set(cam, k);
  dropStereo();
  showIntrinsics();
}

/**
 * Kameras der Splattwin-App liefern ihre Kameradaten selbst: Brennweite und Bildmittelpunkt vom
 * Geraet, das Bild ist bereits entzerrt. Das ersetzt fuer sie das Schachbrett. Wechselt in der App
 * die Linse oder das Format, meldet sich der Stream und die Daten werden erneuert.
 */
function adoptAppCamera(cam: CamId, stream: MediaStream): void {
  const app = appStream(stream);
  if (!app) return;
  const use = () => {
    const k = app.intrinsics;
    if (cam === 'B') ui.camBInfo.textContent = `Kamera B: ${app.info.width}×${app.info.height} · Linse und Zoom in der Splattwin-App`;
    if (!k || JSON.stringify(k) === JSON.stringify(cameras.intrinsics[cam])) return;
    setIntrinsics(cam, k);
  };
  app.onchange = use;
  use();
}

const chess = new ChessboardCalibration(
  (cam) => videos[cam],
  (cam, k) => setIntrinsics(cam, k),
  (text) => (ui.intrStatus.textContent = text),
);
byId('btnChessA').addEventListener('click', () => chess.start('A'));
byId('btnChessB').addEventListener('click', () => chess.start('B'));
byId('btnChessClear').addEventListener('click', () => {
  cameras.clear();
  dropStereo();
  showIntrinsics();
});
showIntrinsics();

// ---------------------------------------------------------------- Quellen
/** Liste der Kameras (ein iPhone erscheint am Mac ueber Continuity Camera automatisch). */
async function listCameras(activeId: string | undefined): Promise<void> {
  const cams = await listVideoInputs();
  const options = () => cams.map((c, i) => new Option(c.label || `Kamera ${i + 1}`, c.deviceId));
  ui.camera.replaceChildren(...options());
  ui.camera.value = activeId ?? '';
  ui.camera.hidden = cams.length < 2;
  const previousB = ui.cameraB.value;
  ui.cameraB.replaceChildren(...options());
  const other = cams.find((c) => c.deviceId !== activeId);
  ui.cameraB.value = cams.some((c) => c.deviceId === previousB) && previousB !== activeId ? previousB : (other?.deviceId ?? '');
  ui.cameraB.hidden = cams.length < 2;
}

// Kameras, die erst spaeter auftauchen (z.B. das iPhone), in die Listen aufnehmen.
navigator.mediaDevices?.addEventListener('devicechange', () => {
  const active = deviceIdOf(ui.video);
  if (active) void listCameras(active);
});

async function startWebcam(deviceId?: string): Promise<void> {
  try {
    const stream = await openCamera(ui.video, deviceId || undefined);
    tracker?.reset();
    adoptAppCamera('A', stream);
    await listCameras(deviceIdOf(ui.video));
  } catch (err) {
    status('Webcam nicht verfügbar: ' + (err as Error).message);
  }
}

async function startVideo(url: string): Promise<void> {
  await openFile(ui.video, url);
  tracker?.reset();
}

function showCamB(): void {
  ui.camBBox.hidden = false;
  tracker?.resetB();
}

async function startCameraB(deviceId: string): Promise<void> {
  try {
    if (!deviceId) {
      // Kameranamen gibt der Browser erst nach der Freigabe heraus.
      if (!ui.video.srcObject) await startWebcam(ui.camera.value);
      deviceId = ui.cameraB.value;
      if (!deviceId) throw new Error('keine zweite Kamera gefunden');
    }
    const stream = await openCamera(ui.videoB, deviceId);
    showCamB();
    setupZoomB(stream.getVideoTracks()[0]!);
    adoptAppCamera('B', stream);
  } catch (err) {
    ui.stereoStatus.textContent = 'Zweite Kamera nicht verfügbar: ' + (err as Error).message;
  }
}

async function startVideoB(url: string): Promise<void> {
  await openFile(ui.videoB, url);
  showCamB();
}

/**
 * Manche Kameras lassen den Zoom (und damit die Linse) vom Browser aus steuern.
 * Ob das iPhone das ueber Continuity Camera anbietet, zeigt sich erst am Geraet.
 */
function setupZoomB(track: MediaStreamTrack): void {
  const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { zoom?: { min: number; max: number; step?: number } };
  const settings = track.getSettings() as MediaTrackSettings & { zoom?: number };
  const row = byId('zoomBRow'),
    slider = input('zoomB');
  ui.camBInfo.textContent = `Kamera B: ${settings.width}×${settings.height}` + (caps.zoom ? '' : ' · Zoom im Browser nicht steuerbar');
  row.hidden = !caps.zoom;
  if (!caps.zoom) return;
  slider.min = String(caps.zoom.min);
  slider.max = String(caps.zoom.max);
  slider.step = String(caps.zoom.step || 0.1);
  slider.value = String(settings.zoom ?? caps.zoom.min);
  byId('zoomBVal').textContent = (+slider.value).toFixed(1);
  slider.onchange = async () => {
    try {
      await track.applyConstraints({ advanced: [{ zoom: +slider.value } as MediaTrackConstraintSet] });
      byId('zoomBVal').textContent = (+slider.value).toFixed(1);
      // Anderer Bildausschnitt: die bisherigen Kameradaten gelten nicht mehr.
      if (cameras.intrinsics.B) setIntrinsics('B', null);
      dropStereo();
    } catch (err) {
      ui.camBInfo.textContent = 'Zoom konnte nicht gesetzt werden: ' + (err as Error).message;
    }
  };
}

byId('btnCam').addEventListener('click', () => void startWebcam(ui.camera.value));
ui.camera.addEventListener('change', () => void startWebcam(ui.camera.value));
input('file').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void startVideo(URL.createObjectURL(f));
});
byId('btnCamB').addEventListener('click', () => void startCameraB(ui.cameraB.value));
ui.cameraB.addEventListener('change', () => {
  if (!ui.camBBox.hidden) void startCameraB(ui.cameraB.value);
});
byId('btnCalib').addEventListener('click', () => {
  if (ui.camBBox.hidden) {
    ui.stereoStatus.textContent = 'Zuerst die zweite Kamera starten.';
    return;
  }
  setStereo(null);
  tracker?.startCalibration(performance.now());
});
byId('btnCalibClear').addEventListener('click', () => {
  setStereo(null);
  tracker?.cancelCalibration();
  clearStereo();
  showStereo();
});

// ---------------------------------------------------------------- Bedienung
ui.upper.checked = query.has('upper');
const setUpper = () => {
  if (retargeter) retargeter.upperBodyOnly = ui.upper.checked;
};
ui.upper.addEventListener('change', setUpper);
byId('btnCenter').addEventListener('click', () => tracker?.recenter());
ui.mirror.addEventListener('change', () => document.body.classList.toggle('mirror', ui.mirror.checked));
ui.debug.addEventListener('change', () => {
  skelRaw.visible = skelFiltered.visible = ui.debug.checked;
});
const showSliders = () => {
  byId('sigmaAVal').textContent = (+ui.sigmaA.value).toFixed(1);
  byId('sigmaZVal').textContent = (+ui.sigmaZ.value).toFixed(1);
};
ui.sigmaA.addEventListener('input', showSliders);
ui.sigmaZ.addEventListener('input', showSliders);
showSliders();

const settings = (): TrackSettings => ({ sigmaA: +ui.sigmaA.value, sigmaZ: +ui.sigmaZ.value / 100, fingers: ui.fingers.checked });

// ---------------------------------------------------------------- Live senden
// Auf die Buehne (live.html): Platz A oder B, Name und Sparmodus werden gemerkt. Wer ueber
// present.<Adresse> eingeloggt ist, hat seinen Platz fest (der Server entscheidet).
const STAGE_KEY = 'splattwin.stage';
const saved = loadJson<{ slot: Slot; name: string; lite: boolean }>(STAGE_KEY);
if (saved) {
  ui.liveSlot.value = saved.slot;
  ui.liveName.value = saved.name;
  ui.liveLite.checked = saved.lite;
}
const saveStage = () => saveJson(STAGE_KEY, { slot: ui.liveSlot.value, name: ui.liveName.value, lite: ui.liveLite.checked });
for (const el of [ui.liveSlot, ui.liveName, ui.liveLite]) el.addEventListener('change', saveStage);

const sender = new LiveSender((text) => (ui.liveInfo.textContent = text));
const link = (href: string, text: string) => Object.assign(document.createElement('a'), { href, textContent: text, target: '_blank' });
fetchLiveInfo()
  .then((info) => {
    if (info.slot) {
      ui.liveSlot.value = info.slot;
      ui.liveSlot.disabled = true;
    }
  })
  .catch(() => {});
ui.liveSlot.addEventListener('change', () => sender.setSlot(ui.liveSlot.value as Slot));
ui.live.addEventListener('change', async () => {
  ui.liveInfo.textContent = '';
  ui.liveLinks.textContent = '';
  if (!ui.live.checked) {
    sender.stop();
    return;
  }
  sender.start(ui.liveSlot.value as Slot);
  try {
    const info = await fetchLiveInfo();
    ui.liveLinks.replaceChildren(
      ...(info.urls.length ? info.urls.map((url) => link(url, url)) : [link('/live.html', 'Bühne (nur dieser Rechner)')]),
      link('/control.html', 'Regie: Folien hochladen und umschalten'),
      document.createTextNode(info.presenterUrl ? `Presenter-Login zum Testen: ${info.presenterUrl}` : ''),
      document.createTextNode(info.urls.length || info.slot ? '' : ' · für andere Geräte im WLAN den Server mit --lan starten'),
    );
  } catch {
    ui.liveInfo.textContent = 'Server nicht erreichbar';
  }
});

// ---------------------------------------------------------------- Pro Bild
const overlayA = new Overlay(ui.video, byId<HTMLCanvasElement>('overlay'));
const overlayB = new Overlay(ui.videoB, byId<HTMLCanvasElement>('overlayB'));

function showCalibration(f: TrackFrame): void {
  const c = f.calibration;
  if (!c) return;
  if (c.state === 'collecting') {
    ui.stereoStatus.textContent = `Kalibriere … noch ${c.left.toFixed(0)} s, ${c.frames} Aufnahmen. Bewege dich und die Arme.`;
  } else if (c.state === 'failed') {
    ui.stereoStatus.textContent = 'Kalibrierung fehlgeschlagen: ' + c.error;
  } else {
    const s = { R: c.result.R, T: c.result.T, rms: c.result.rms, baseline: c.result.baseline, fovA: +ui.fov.A.value, fovB: +ui.fov.B.value };
    setStereo(s);
    saveStereo(s);
    showStereo();
  }
}

function apply(f: TrackFrame): void {
  const useFilter = ui.kalman.checked;
  const pts = useFilter ? f.filtered : f.raw;
  const hands = useFilter ? f.filteredHands : f.rawHands;
  if (retargeter) {
    retargeter.apply(toVectors(pts) ?? [], { Left: toVectors(hands.Left), Right: toVectors(hands.Right) });
    const r = useFilter ? f.root : f.rawRoot;
    const pos = retargeter.model.position;
    // Nur Oberkoerper: Die Position im Raum haengt an der Huefte, also bleibt die Figur stehen.
    if (ui.upper.checked || !ui.move.checked) {
      pos.x = pos.z = 0;
    } else if (r && f.origin) {
      pos.x = r[0] - f.origin[0];
      pos.z = r[2] - f.origin[2];
    }
    if (ui.live.checked) {
      sender.send(
        { t: performance.now(), upper: ui.upper.checked, mirror: ui.mirror.checked, pos: [pos.x, pos.z], pts, hands },
        { name: ui.liveName.value.trim().slice(0, 24), run: RUN },
      );
    }
  }
  skelRaw.update(toVectors(f.raw) ?? []);
  skelFiltered.update(toVectors(f.filtered) ?? []);
  const distance = f.rawRoot ? ` · Distanz ${(-f.rawRoot[2]).toFixed(2)} m` : '';
  status(
    f.personSeen
      ? `Person erkannt · ${f.fps.toFixed(0)} fps${distance}` +
          (f.mode === 'stereo'
            ? ` · Stereo: ${f.nTri} Gelenke trianguliert · EKF: ${f.fused} Gelenke, ${f.rejected} Messungen verworfen`
            : ' · eine Kamera')
      : `Keine Person im Bild · ${f.fps.toFixed(0)} fps`,
  );
}

// Erkennung bei jedem Kamerabild, die eigene 3D-Vorschau aber hoechstens 30-mal pro Sekunde (120-Hz-
// Bildschirme zeichneten sonst viermal so oft) und beim Senden im Sparmodus nur 15-mal: Die
// Grafikkarte bleibt fuer MediaPipe frei, es kommen mehr Bilder auf der Buehne an.
let lastRender = 0;
renderer.setAnimationLoop((now: number) => {
  try {
    if (tracker) {
      const s = settings();
      const b = tracker.stepB(now, s);
      if (b) overlayB.draw(b.img);
      const f = tracker.stepA(now, s);
      if (f) {
        overlayA.draw(f.img, f.handsImg);
        showCalibration(f);
        apply(f);
      }
    }
  } catch (err) {
    console.error(err);
    status('Fehler: ' + (err as Error).message);
  }
  const interval = ui.live.checked && ui.liveLite.checked ? 1000 / 15 : 1000 / 30;
  if (now - lastRender < interval - 2) return;
  lastRender = now;
  controls.update();
  renderer.render(scene, camera);
});

// ---------------------------------------------------------------- Start
async function loadSplat(): Promise<void> {
  if (!RUN || !retargeter) return;
  try {
    // upload: einmal vorgerechnet liegt der Splat als skin.bin beim Server, die Buehne laedt nur noch diese Datei.
    const splat = await loadSplatAvatar(scene, renderer, retargeter, RUN, { debugParts: query.has('parts'), upload: true });
    ui.splat.disabled = false;
    ui.splat.checked = true;
    // Roboter halbdurchsichtig unter dem Splat zeigt, wo die Zuteilung der Kleckse noch hakt.
    const ghost = input('ghost'),
      splatOp = input('splatOp'),
      wire = input('ghostWire'),
      parts = input('parts');
    if (query.has('ghost')) ghost.value = query.get('ghost')!;
    parts.checked = query.has('parts');
    const updateView = () => {
      byId('ghostVal').textContent = ghost.value;
      byId('splatOpVal').textContent = splatOp.value;
      byId('splatView').hidden = !ui.splat.checked;
      splat.setView({ splat: ui.splat.checked, robotOpacity: +ghost.value / 100, splatOpacity: +splatOp.value / 100, wireframe: wire.checked });
    };
    for (const el of [ui.splat, wire]) el.addEventListener('change', updateView);
    for (const el of [ghost, splatOp]) el.addEventListener('input', updateView);
    parts.addEventListener('change', () => {
      const url = new URL(location.href);
      if (parts.checked) url.searchParams.set('parts', '');
      else url.searchParams.delete('parts');
      location.href = url.href;
    });
    updateView();
  } catch (err) {
    console.warn('Splat-Avatar nicht geladen:', err);
  }
}

try {
  status('Lade Modelle …');
  const [robot, pose, poseB, hands] = await Promise.all([
    loadRobot(scene, MODEL_URL),
    createPoseLandmarker(),
    createPoseLandmarker(),
    createHandLandmarker(),
  ]);
  retargeter = robot;
  setUpper();
  tracker = new Tracker({ pose, poseB, hands }, ui.video, ui.videoB, cameras, bridgeBaseline);
  status('Bereit. Webcam starten oder Video laden.');
  const saved = loadStereo();
  if (saved) {
    if (saved.fovA) ui.fov.A.value = String(saved.fovA);
    if (saved.fovB) ui.fov.B.value = String(saved.fovB);
    readFov();
    setStereo(saved);
    showStereo(' (gespeichert)');
  }
  await loadSplat();
  const src = query.get('src'),
    srcB = query.get('srcB');
  if (src) await startVideo(src);
  if (srcB) await startVideoB(srcB);
} catch (err) {
  console.error(err);
  status('Fehler beim Laden: ' + (err as Error).message);
}

// Fuer Tests in der Konsole.
Object.assign(window, {
  app: {
    scene,
    camera,
    controls,
    cameras,
    get tracker() {
      return tracker;
    },
    get retargeter() {
      return retargeter;
    },
  },
});
