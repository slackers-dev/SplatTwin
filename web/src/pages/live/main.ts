// Buehne (Zuschauerseite): zwei Presenter und die Folien in einem 3D-Raum, live fuer alle.
//
// Keine Kamera, keine Erkennung: Die Seite empfaengt ueber /ws/stage den Folienstand, Name und Lauf
// je Platz und die Bilder der Tracking-Seiten (src/live). Die Presenter stehen als Splat oder Roboter
// auf der Buehne (avatar/presenter), die Folien haengen als Leinwand an der Rueckwand (slides).
// Laeuft auch auf Handy oder Tablet; ?q=hoch oder ?q=niedrig erzwingt eine Qualitaetsstufe,
// ?splat=0 zeigt nur die Roboter.
import './style.css';
import { Presenter } from '../../avatar/presenter';
import { loadRobotTemplate } from '../../avatar/robot';
import { createRoom, seatPosition, type ViewName } from '../../avatar/room';
import type { StageSlides } from '../../contracts';
import type { Slot } from '../../live/protocol';
import { connectStage } from '../../live/receiver';
import { drawPlaceholder, loadSlides, renderSlide } from '../../slides/slides';
import { byId, params } from '../../ui/dom';

const query = params();
const weakDevice = matchMedia('(pointer: coarse)').matches || (navigator.hardwareConcurrency || 8) <= 4;
const quality = query.get('q');

const statusEl = byId('status');
const setStatus = (text: string, ok = false) => {
  statusEl.textContent = text;
  statusEl.classList.toggle('ok', ok);
};

const presenters: Partial<Record<Slot, Presenter>> = {};
const room = createRoom(byId<HTMLCanvasElement>('scene'), {
  low: quality === 'niedrig' || (quality !== 'hoch' && weakDevice),
  autoLow: !quality,
  presenterAt: (slot) => presenters[slot]?.position() ?? seatPosition(slot),
});

// ---------------------------------------------------------------- Ansichten
const viewButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-view]')];
const setView = (name: ViewName) => {
  room.setView(name);
  for (const b of viewButtons) b.setAttribute('aria-pressed', String(b.dataset.view === name));
};
for (const b of viewButtons) b.addEventListener('click', () => setView(b.dataset.view as ViewName));

// ---------------------------------------------------------------- Folien
let slides: StageSlides = { doc: null, page: 1, pages: 0 };
let drawing = Promise.resolve();
const big = byId('big'),
  bigCanvas = byId<HTMLCanvasElement>('bigCanvas'),
  btnBig = byId('btnBig');

async function drawBig(): Promise<void> {
  const width = Math.min(2400, Math.round(innerWidth * Math.min(devicePixelRatio, 2)));
  if (slides.doc) await renderSlide(await loadSlides(slides.doc), slides.page, bigCanvas, width);
  else drawPlaceholder(bigCanvas, 'Gleich geht es los');
  bigCanvas.style.aspectRatio = `${bigCanvas.width} / ${bigCanvas.height}`;
}

async function drawSlide(): Promise<void> {
  byId('page').textContent = slides.pages ? `Folie ${slides.page} / ${slides.pages}` : '–';
  try {
    const aspect = slides.doc
      ? await renderSlide(await loadSlides(slides.doc), slides.page, room.screenCanvas, 2048)
      : drawPlaceholder(room.screenCanvas, 'Gleich geht es los');
    room.screenChanged(aspect);
    if (!big.hidden) await drawBig();
  } catch (err) {
    console.error(err);
    setStatus('Folie konnte nicht geladen werden: ' + (err as Error).message);
  }
}
room.screenChanged(drawPlaceholder(room.screenCanvas, 'Gleich geht es los'));

// «Folie gross»: 2D und gut lesbar, vor allem auf dem Handy.
function toggleBig(on = big.hidden): void {
  big.hidden = !on;
  btnBig.setAttribute('aria-pressed', String(on));
  if (on) void drawBig();
}
btnBig.addEventListener('click', () => toggleBig());
big.addEventListener('click', () => toggleBig(false));

// ---------------------------------------------------------------- Splat oder Roboter
let splatOn = query.get('splat') !== '0';
const btnSplat = byId('btnSplat');
function toggleSplat(on = !splatOn): void {
  splatOn = on;
  btnSplat.setAttribute('aria-pressed', String(on));
  for (const p of Object.values(presenters)) p.setSplatOn(on);
}
btnSplat.addEventListener('click', () => toggleSplat());
btnSplat.setAttribute('aria-pressed', String(splatOn));

addEventListener('keydown', (e) => {
  const views: ViewName[] = ['publikum', 'buehne', 'folie', 'A', 'B'];
  if (e.key >= '1' && e.key <= '5') setView(views[+e.key - 1]!);
  if (e.key === 'f' || e.key === 'F') toggleBig();
  if (e.key === 's' || e.key === 'S') toggleSplat();
  if (e.key === 'Escape') toggleBig(false);
});

// ---------------------------------------------------------------- Start
room.renderer.setAnimationLoop((now: number) => room.frame(now)); // Raum schon zeigen, waehrend der Roboter laedt

try {
  const template = await loadRobotTemplate();
  for (const slot of ['A', 'B'] as const) {
    const p = new Presenter(slot, room.scene, room.renderer, template);
    p.setSplatOn(splatOn);
    presenters[slot] = p;
  }
} catch (err) {
  console.error(err);
  setStatus('Roboter konnte nicht geladen werden: ' + (err as Error).message);
}

let connected = false;
connectStage({
  open: () => (connected = true),
  close: () => (connected = false),
  slides: (state) => {
    slides = state;
    drawing = drawing.then(drawSlide);
  },
  // Name und Lauf kommen schon beim Verbinden: der Splat laedt, bevor der Presenter sendet.
  meta: (slot, meta) => presenters[slot]?.setMeta(meta),
  frame: (slot, frame) => presenters[slot]?.receive(frame, performance.now()),
});

room.renderer.setAnimationLoop((now: number) => {
  const list = Object.values(presenters);
  for (const p of list) {
    p.update(now);
    const chip = byId('chip' + p.slot);
    chip.classList.toggle('on', p.online);
    // Bilder pro Sekunde je Presenter: zeigt sofort, wenn eine Tracking-Seite bremst.
    chip.textContent = `${p.slot} · ${p.name || (p.online ? 'live' : 'frei')}` + (p.online ? ` · ${p.rate} B/s` : '');
  }
  const live = list.filter((p) => p.online).length;
  const loading = list.find((p) => p.loading);
  const suffix = loading ? ` · lade Splat ${loading.slot} …` : '';
  if (!connected) setStatus('Verbindung unterbrochen, versuche es weiter …');
  else if (live) setStatus(`live · ${live === 2 ? 'beide Presenter' : '1 Presenter'} auf der Bühne${suffix}`, true);
  else setStatus('verbunden · warte auf die Presenter …' + suffix);
  room.frame(now);
});
