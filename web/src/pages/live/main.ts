// Zuschauerseite: zeigt den Avatar, den die Tracking-Seite («Live senden») bewegt.
//
// Keine Kamera und keine Erkennung: Die Seite empfaengt pro Bild die Gelenkpunkte vom Server
// (Server-Sent Events) und gibt sie demselben Retargeter wie die Tracking-Seite. Laeuft auch auf
// Handy oder Tablet im selben WLAN (splattwin serve --lan).
//
// ?run=<lauf> waehlt den Splat; ohne Angabe wird der Lauf der Tracking-Seite genommen.
import './style.css';
import { toVectors } from '../../avatar/points';
import { loadRobot } from '../../avatar/robot';
import { loadSplatAvatar } from '../../avatar/splat-avatar';
import { createStage } from '../../avatar/stage';
import type { LiveFrame } from '../../contracts';
import { subscribeLive } from '../../live/receiver';
import { byId, params } from '../../ui/dom';

const STALE_MS = 1500; // so lange ohne Bild gilt der Tracker als pausiert

const statusEl = byId('status');
const setStatus = (text: string, ok = false) => {
  statusEl.textContent = text;
  statusEl.classList.toggle('ok', ok);
};

const { renderer, scene, camera, controls } = createStage(byId<HTMLCanvasElement>('scene'));
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

let latest: LiveFrame | null = null; // letztes empfangenes Bild, wird pro Animationsbild einmal angewendet
let lastTime = 0;
let frames = 0,
  fps = 0,
  fpsStart = performance.now();

// Der erste Frame verraet den Lauf der Tracking-Seite, falls ?run fehlt.
const firstFrame = new Promise<LiveFrame>((resolve) => {
  subscribeLive(
    (frame) => {
      latest = frame;
      lastTime = performance.now();
      frames++;
      resolve(frame);
    },
    () => setStatus('Verbindung zum Server unterbrochen, versuche es weiter …'),
  );
});

try {
  const retargeter = await loadRobot(scene);
  const applyFrame = (f: LiveFrame) => {
    retargeter.upperBodyOnly = !!f.upper;
    retargeter.apply(toVectors(f.pts) ?? [], { Left: toVectors(f.hands?.Left), Right: toVectors(f.hands?.Right) });
    retargeter.model.position.x = f.pos?.[0] ?? 0;
    retargeter.model.position.z = f.pos?.[1] ?? 0;
    document.body.classList.toggle('mirror', !!f.mirror);
  };

  setStatus('warte auf die Tracking-Seite («Live senden» einschalten) …');
  const run = params().get('run') || (await firstFrame).run;

  if (run) {
    try {
      setStatus(`lade Splat ${run} …`);
      const splat = await loadSplatAvatar(scene, renderer, retargeter, run);
      const box = byId<HTMLInputElement>('splat');
      box.disabled = false;
      box.addEventListener('change', () => splat.setVisible(box.checked));
      splat.setVisible(true);
    } catch (err) {
      console.warn('Splat nicht geladen, zeige den Roboter:', err);
    }
  }

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    if (latest) {
      applyFrame(latest);
      latest = null;
    }
    if (now - fpsStart > 1000) {
      fps = (frames * 1000) / (now - fpsStart);
      frames = 0;
      fpsStart = now;
    }
    if (now - lastTime > STALE_MS) setStatus('Tracking pausiert, warte auf neue Bilder …');
    else setStatus(`live · ${fps.toFixed(0)} Bilder/s`, true);
    controls.update();
    renderer.render(scene, camera);
  });
} catch (err) {
  console.error(err);
  setStatus('Fehler beim Laden: ' + (err as Error).message);
}
