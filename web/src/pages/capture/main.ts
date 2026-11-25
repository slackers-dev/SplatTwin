// Gefuehrte Aufnahme fuer den Splat: leerer Raum, Pose, Drehung, optional Gesichtsscan.
// Die Videos und die Metadatei (capture.json) speichert der Server in data/captures/.
//
// Zum Testen ohne Kamera: ?srcA=<video> (und srcB) spielt ein Video als Kamerabild ab;
// ?hold, ?gate, ?bg, ?turn setzen die Zeiten.
import './style.css';
import type { NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision';
import { analyse, type CaptureMode, emptyState, type PersonState } from '../../capture/analyse';
import { type FlowUI, pose, turn, waitFor } from '../../capture/flow';
import { MIME, type Recording, record, saveMeta, upload } from '../../capture/recorder';
import { Speaker } from '../../capture/speech';
import type { Capture, SavedVideo } from '../../contracts';
import { createPoseLandmarker } from '../../tracking/detectors';
import { byId, numberParam, params } from '../../ui/dom';

const LINES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]] as const;

const query = params();
type Key = 'a' | 'b';
const SRC: Record<Key, string | null> = { a: query.get('srcA'), b: query.get('srcB') };
const HOLD = numberParam('hold', 1.5); // so lange muss die Pose stimmen, bevor die Drehung beginnt
const GATE_TIMEOUT = numberParam('gate', 40); // danach geht es auch ohne erfuellte Bedingung weiter
const field = (id: string) => byId<HTMLInputElement>(id);
const select = (id: string) => byId<HTMLSelectElement>(id);
if (query.get('bg')) field('tBg').value = query.get('bg')!;
if (query.get('turn')) field('tTurn').value = query.get('turn')!;

let mode: CaptureMode = 'body'; // 'face' waehrend des Gesichtsscans: dann gelten andere Pruefungen

interface Cam {
  key: Key;
  select: HTMLSelectElement;
  view: HTMLElement;
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  pic: HTMLCanvasElement;
  tag: HTMLElement;
  size: [number, number];
  stream: MediaStream | null;
  landmarker: PoseLandmarker | null;
  lastTime: number;
  state: PersonState;
}

function makeCam(key: Key): Cam {
  const view = byId('view' + key.toUpperCase());
  return {
    key,
    select: select('cam' + key.toUpperCase()),
    view,
    video: view.querySelector('video')!,
    canvas: view.querySelector('canvas.overlay')!,
    pic: view.querySelector('canvas.pic')!,
    tag: view.querySelector('.tag')!,
    size: [0, 0],
    stream: null,
    landmarker: null,
    lastTime: -1,
    state: emptyState(),
  };
}
const cams: Record<Key, Cam> = { a: makeCam('a'), b: makeCam('b') };
const active = () => Object.values(cams).filter((c) => c.stream);

const speaker = new Speaker();
const ui: FlowUI = {
  phase(text, recording = false) {
    const el = byId('phase');
    el.textContent = text;
    el.classList.toggle('rec', recording);
  },
  progress(f) {
    (byId('bar').firstElementChild as HTMLElement).style.width = `${Math.max(0, Math.min(f, 1)) * 100}%`;
  },
  say: (text, minGap) => speaker.say(text, minGap),
};

function showError(err: unknown): void {
  console.error(err);
  ui.phase('Fehler: ' + (err as Error).message);
  byId<HTMLButtonElement>('start').disabled = false;
}

// ---------------------------------------------------------------- Kameras
async function openCamera(key: Key): Promise<void> {
  const cam = cams[key];
  cam.stream?.getTracks().forEach((t) => t.stop());
  cam.stream = null;
  const src = SRC[key];
  if (src) {
    cam.video.src = src;
    cam.video.autoplay = false;
    await new Promise((r) => cam.video.addEventListener('loadeddata', r, { once: true }));
    cam.stream = (cam.video as HTMLVideoElement & { captureStream(): MediaStream }).captureStream();
  } else if (cam.select.value) {
    cam.stream = await navigator.mediaDevices.getUserMedia({
      // 1920x1440 ist das volle Bild des Handys (4:3). Mit 1920x1080 schneidet der Browser oben und unten ab.
      video: { deviceId: { exact: cam.select.value }, width: { ideal: 1920 }, height: { ideal: 1440 }, frameRate: { ideal: 30 } },
    });
    // Hinweis: Chrome lieferte das iPhone ueber die Integrationskamera bisher nur mit 1280x720.
    cam.video.srcObject = cam.stream;
    cam.video.play().catch(() => {}); // nicht darauf warten: ohne Bild vom Handy kaeme das nie zurueck
  } else cam.video.srcObject = null;
  cam.view.hidden = !cam.stream;
}

async function listCameras(): Promise<void> {
  let devices: MediaDeviceInfo[] = [];
  if (!SRC.a) {
    // Erst nach der Freigabe liefert der Browser die Namen der Kameras.
    const probe = await navigator.mediaDevices.getUserMedia({ video: true });
    probe.getTracks().forEach((t) => t.stop());
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  }
  for (const cam of Object.values(cams)) {
    const options = devices.map((d, i) => new Option(d.label || 'Kamera ' + (i + 1), d.deviceId));
    cam.select.replaceChildren(...(cam.key === 'b' ? [new Option('keine', ''), ...options] : options));
    cam.select.addEventListener('change', () => openCamera(cam.key).catch(showError));
  }
  // Das Handy ist die bessere Kamera: wenn eines verbunden ist, wird es Kamera A.
  const phone = devices.find((d) => /iphone|ipad|handy|phone/i.test(d.label));
  if (phone) cams.a.select.value = phone.deviceId;
  await Promise.all([openCamera('a'), openCamera('b')]);
}

// ---------------------------------------------------------------- Anzeige
function draw(cam: Cam): void {
  const { canvas, video, state } = cam;
  const w = canvas.clientWidth,
    h = canvas.clientHeight;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const g = canvas.getContext('2d')!;
  g.clearRect(0, 0, w, h);
  cam.view.classList.toggle('ok', state.present && state.full);
  cam.view.classList.toggle('bad', state.present && !state.full);
  cam.tag.textContent =
    cam.key.toUpperCase() +
    (cam.size[0] ? ` · ${cam.size[0]}×${cam.size[1]}` : '') +
    (state.present ? (state.full ? ' · gut im Bild' : ' · ' + state.hint) : ' · niemand');
  if (!video.videoWidth) cam.tag.textContent = cam.key.toUpperCase() + ' · kein Bild – ist das Handy entsperrt und in der Nähe?';
  if (!state.img || !cam.size[0]) return;
  // Gleiche Einpassung wie object-fit: contain.
  const [vw, vh] = cam.size;
  const k = Math.min(w / vw, h / vh);
  const ox = (w - vw * k) / 2,
    oy = (h - vh * k) / 2;
  const img = state.img;
  const px = (i: number): [number, number] => [ox + img[i]!.x * vw * k, oy + img[i]!.y * vh * k];
  g.lineWidth = 3;
  g.strokeStyle = state.full ? '#6cc4a1' : '#e5625e';
  g.beginPath();
  for (const [i, j] of LINES) {
    g.moveTo(...px(i));
    g.lineTo(...px(j));
  }
  g.stroke();
}

/**
 * Liefert das aufrechte Bild der Kamera. Steht das Handy hochkant, kommt sein Bild je nach
 * System liegend an: dann wird es hier gedreht, fuer die Anzeige und fuer die Koerpererkennung.
 */
function upright(cam: Cam): HTMLVideoElement | HTMLCanvasElement {
  const { video, pic } = cam;
  const rot = cam.key === 'a' ? +select('rot').value : 0;
  pic.hidden = !rot;
  video.style.visibility = rot ? 'hidden' : '';
  if (!rot) {
    cam.size = [video.videoWidth, video.videoHeight];
    return video;
  }
  if (pic.width !== video.videoHeight || pic.height !== video.videoWidth) {
    pic.width = video.videoHeight;
    pic.height = video.videoWidth;
  }
  const g = pic.getContext('2d')!;
  g.save();
  if (rot === 90) {
    g.translate(pic.width, 0);
    g.rotate(Math.PI / 2);
  } else {
    g.translate(0, pic.height);
    g.rotate(-Math.PI / 2);
  }
  g.drawImage(video, 0, 0);
  g.restore();
  cam.size = [pic.width, pic.height];
  return pic;
}

function tick(now: number): void {
  for (const cam of Object.values(cams)) {
    if (!cam.stream) continue;
    if (cam.landmarker && cam.video.readyState >= 2 && cam.video.currentTime !== cam.lastTime) {
      cam.lastTime = cam.video.currentTime;
      const result = cam.landmarker.detectForVideo(upright(cam), now);
      cam.state = analyse(result.landmarks?.[0] as NormalizedLandmark[] | undefined, result.worldLandmarks?.[0], mode);
    }
    draw(cam);
  }
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- Aufnahme
async function run(): Promise<void> {
  const name = field('name').value.trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) throw new Error('Name: nur Buchstaben, Ziffern, - und _');
  if (!cams.a.stream || !cams.a.video.videoWidth) throw new Error('Kamera A liefert kein Bild');
  const bgSeconds = +field('tBg').value,
    turnSeconds = +field('tTurn').value;
  byId<HTMLButtonElement>('start').disabled = true;
  byId('out').hidden = true;
  for (const cam of active()) if (SRC[cam.key]) await cam.video.play();

  const recs: Partial<Record<Key, Recording>> = {};
  for (const cam of active()) recs[cam.key] = record(cam.stream!);
  while (Object.values(recs).some((r) => r.startedAt === null)) await new Promise((r) => setTimeout(r, 10));
  const t0 = recs.a!.startedAt!;
  const sec = (t: number) => (t - t0) / 1000; // Sekunden im Video A
  const marks: Capture['marks'] = {},
    notes: string[] = [];
  const A = () => cams.a.state;

  // 1. Leerer Raum: zaehlt nur, solange keine Kamera eine Person sieht.
  ui.phase('Geh aus dem Bild', true);
  ui.say('Aufnahme läuft. Geh aus dem Bild.');
  const empty = await waitFor(() => active().every((c) => !c.state.present), bgSeconds, 30, ui, () => {
    if (active().some((c) => c.state.present)) ui.phase('Geh aus dem Bild – ich sehe dich noch', true);
    else ui.phase('Leerer Raum – draussen bleiben', true);
  });
  if (empty !== null) {
    marks.bgStart = sec(empty);
    marks.bgEnd = sec(performance.now());
  } else notes.push('Kein leerer Raum erkannt: ohne Hintergrundbild.');

  // 2. Pose: ganz im Bild, schaut zu Kamera A, steht still.
  ui.phase('Komm ins Bild und schau zu Kamera A', true);
  ui.say('Komm ins Bild. Schau zur Kamera. Arme leicht vom Körper weg.');
  await pose('Körper', notes, A, ui, HOLD, GATE_TIMEOUT);

  // 3. Drehung: der Winkel der Schulterlinie wird mitgezaehlt, bis 360 Grad voll sind.
  marks.turnStart = sec(performance.now());
  marks.turnedDegrees = await turn('Körper', notes, A, ui, turnSeconds);
  marks.turnEnd = sec(performance.now());

  // 4. Gesichtsscan: nah an die Kamera, zweite Drehung. Der leere Raum von vorhin gilt weiter.
  if (select('face').value === '1') {
    mode = 'face';
    ui.phase('Komm nah an die Kamera', true);
    ui.say('Gut. Jetzt komm nah an die Kamera, bis Kopf und Schultern das Bild füllen.');
    await pose('Gesicht', notes, A, ui, HOLD, GATE_TIMEOUT);
    marks.faceStart = sec(performance.now());
    marks.faceDegrees = await turn('Gesicht', notes, A, ui, turnSeconds);
    marks.faceEnd = sec(performance.now());
    mode = 'body';
  }
  ui.say('Fertig.');

  for (const r of Object.values(recs)) r.rec.stop();
  ui.phase('Speichere und wandle um …');
  // Kamera B startet einen Hauch frueher oder spaeter: ein Ereignis liegt in B um "offset" spaeter.
  const offset = recs.b ? (recs.a!.startedAt! - recs.b.startedAt!) / 1000 : 0;
  const saved: Record<string, SavedVideo> = {};
  for (const [key, r] of Object.entries(recs)) {
    // Der Server dreht die gespeicherte Aufnahme gleich wie die Anzeige.
    saved[key] = await upload(name, key, await r.done, key === 'a' ? +select('rot').value : 0);
  }
  const meta: Capture = { name, marks, offset, saved, notes, mime: MIME };
  await saveMeta(name, meta);

  const f1 = (x: number) => x.toFixed(1);
  const out = byId('out');
  out.textContent =
    Object.entries(saved)
      .map(([k, i]) => `Kamera ${k.toUpperCase()}: ${i.saved}, ${i.width}×${i.height}, ${i.seconds} s`)
      .join('\n') +
    `\nKörper: ${Math.abs(marks.turnedDegrees)}° in ${f1(marks.turnEnd - marks.turnStart)} s` +
    (marks.faceStart !== undefined ? `\nGesicht: ${Math.abs(marks.faceDegrees!)}° in ${f1(marks.faceEnd! - marks.faceStart)} s` : '') +
    (notes.length ? '\nHinweise: ' + notes.join(' ') : '') +
    `\n\nuv run splattwin process ${name}`;
  out.hidden = false;
  ui.phase(notes.length ? 'Fertig – mit Hinweisen, siehe unten' : 'Fertig – Befehl steht unten');
  ui.progress(0);
  byId<HTMLButtonElement>('start').disabled = false;
}

byId('start').addEventListener('click', () => run().catch(showError));

// Jede Aufnahme bekommt einen eigenen Namen, damit keine aeltere ueberschrieben wird.
const d = new Date();
field('name').value = `scan-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;

try {
  await listCameras();
  ui.phase('Lade Körpererkennung …');
  // Eigene Instanz pro Kamera: im Video-Modus merkt sich das Modell den Verlauf.
  for (const cam of Object.values(cams)) cam.landmarker = await createPoseLandmarker();
  requestAnimationFrame(tick);
  ui.phase('Bereit');
} catch (err) {
  showError(err);
}
