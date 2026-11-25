// Regie: Folien als PDF hochladen und umschalten, sehen, wer live ist und mit wie vielen Bildern pro
// Sekunde. Nur fuer Presenter (dieser Rechner oder eingeloggt ueber present.<Adresse>).
import './style.css';
import type { StageSlides } from '../../contracts';
import { SLOTS } from '../../live/protocol';
import { connectStage } from '../../live/receiver';
import { fetchLiveInfo } from '../../live/sender';
import { drawPlaceholder, loadSlides, renderSlide } from '../../slides/slides';
import { byId } from '../../ui/dom';

let state: StageSlides = { doc: null, page: 1, pages: 0 };
const status = (text: string) => (byId('status').textContent = text);

async function post<T>(path: string, body: BodyInit): Promise<T> {
  const r = await fetch(path, { method: 'POST', body });
  const data = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? String(r.status));
  return data;
}

// Zeichnen nacheinander, damit sich zwei Aufrufe nicht in die Quere kommen.
let queue = Promise.resolve();
const show = () => (queue = queue.then(draw));
async function draw(): Promise<void> {
  byId('page').textContent = state.pages ? `${state.page} / ${state.pages}` : '–';
  const cur = byId<HTMLCanvasElement>('cur'),
    nxt = byId<HTMLCanvasElement>('nxt');
  if (!state.doc) {
    drawPlaceholder(cur);
    drawPlaceholder(nxt, '');
    return;
  }
  try {
    const pdf = await loadSlides(state.doc);
    // Die Anzahl kennt erst, wer das PDF liest: die Regie meldet sie dem Server.
    if (!state.pages) await post('/api/slide', JSON.stringify({ pages: pdf.numPages }));
    await renderSlide(pdf, state.page, cur, 1600);
    if (state.page < pdf.numPages) await renderSlide(pdf, state.page + 1, nxt, 700);
    else drawPlaceholder(nxt, 'Letzte Folie');
  } catch (err) {
    status('PDF konnte nicht angezeigt werden: ' + (err as Error).message);
  }
}

function go(delta: number): void {
  if (!state.pages) return;
  const page = Math.max(1, Math.min(state.pages, state.page + delta));
  if (page === state.page) return;
  state = { ...state, page }; // sofort zeigen, der Server bestaetigt ueber /ws/stage
  show();
  post('/api/slide', JSON.stringify({ page })).catch((e: Error) => status(e.message));
}

byId('prev').onclick = () => go(-1);
byId('next').onclick = () => go(1);
addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  if (['ArrowRight', 'PageDown', ' '].includes(e.key)) {
    e.preventDefault();
    go(1);
  }
  if (['ArrowLeft', 'PageUp'].includes(e.key)) {
    e.preventDefault();
    go(-1);
  }
  if (e.key === 'Home') go(-1e6);
  if (e.key === 'End') go(1e6);
});

const file = byId<HTMLInputElement>('file');
file.onchange = async () => {
  const f = file.files?.[0];
  if (!f) return;
  status(`lade ${f.name} hoch …`);
  try {
    await post(`/api/slides?name=${encodeURIComponent(f.name)}`, f);
    status(`${f.name} ist auf der Bühne.`);
  } catch (err) {
    status('Hochladen fehlgeschlagen: ' + (err as Error).message);
  }
  file.value = '';
};

// ---------------------------------------------------------------- Live-Stand
const lastSeen = { A: 0, B: 0 },
  names = { A: '', B: '' },
  frames = { A: 0, B: 0 };
connectStage({
  slides: (s) => {
    state = s;
    show();
  },
  meta: (slot, meta) => (names[slot] = meta.name),
  frame: (slot) => {
    lastSeen[slot] = performance.now();
    frames[slot]++;
  },
});
setInterval(() => {
  for (const slot of SLOTS) {
    const on = performance.now() - lastSeen[slot] < 2000;
    const chip = byId('chip' + slot);
    chip.classList.toggle('on', on);
    chip.textContent = `${slot}${names[slot] ? ' · ' + names[slot] : ''} · ${on ? frames[slot] + ' B/s' : 'offline'}`;
    frames[slot] = 0;
  }
}, 1000);

async function info(): Promise<void> {
  try {
    const i = await fetchLiveInfo();
    byId('viewers').textContent = `${i.viewers} verbunden`;
    byId('logout').hidden = !i.slot;
  } catch {
    /* naechster Versuch in 5 s */
  }
}
void info();
setInterval(info, 5000);
byId('logout').onclick = async () => {
  await post('/api/logout', '');
  location.href = '/login.html';
};
