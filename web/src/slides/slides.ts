// Folien der Buehne: das hochgeladene PDF (/stage/slides.pdf) laden und einzelne Seiten in ein Canvas
// zeichnen (pdf.js). PowerPoint und Keynote: als PDF exportieren. "doc" im Folienstand aendert sich bei
// jedem Upload, damit niemand eine alte Fassung aus dem Cache bekommt.
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

let current: { doc: string; pdf: pdfjs.PDFDocumentProxy } | null = null;

export async function loadSlides(doc: string): Promise<pdfjs.PDFDocumentProxy> {
  if (current?.doc === doc) return current.pdf;
  const pdf = await pdfjs.getDocument(`/stage/slides.pdf?v=${encodeURIComponent(doc)}`).promise;
  current = { doc, pdf };
  return pdf;
}

// Laufendes Zeichnen pro Canvas: ein neues bricht nur das alte im selben Canvas ab.
const tasks = new WeakMap<HTMLCanvasElement, pdfjs.RenderTask>();

/** Zeichnet Seite n (ab 1) so, dass sie width Pixel breit ist. Rueckgabe: Seitenverhaeltnis. */
export async function renderSlide(pdf: pdfjs.PDFDocumentProxy, n: number, canvas: HTMLCanvasElement, width: number): Promise<number> {
  const page = await pdf.getPage(Math.max(1, Math.min(n, pdf.numPages)));
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / base.width });
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  tasks.get(canvas)?.cancel();
  const task = page.render({ canvasContext: canvas.getContext('2d')!, viewport });
  tasks.set(canvas, task);
  try {
    await task.promise;
  } catch (err) {
    if ((err as Error)?.name !== 'RenderingCancelledException') throw err;
  }
  return base.width / base.height;
}

/** Platzhalter, solange keine Folien hochgeladen sind. Rueckgabe: Seitenverhaeltnis. */
export function drawPlaceholder(canvas: HTMLCanvasElement, text = 'Noch keine Folien'): number {
  canvas.width = 1600;
  canvas.height = 900;
  const g = canvas.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 1600, 900);
  grad.addColorStop(0, '#1b2a26');
  grad.addColorStop(1, '#1e2140');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1600, 900);
  g.textAlign = 'center';
  g.fillStyle = '#e6e8ec';
  g.font = '600 92px system-ui, sans-serif';
  g.fillText('SplatTwin', 800, 430);
  g.fillStyle = '#9aa1ad';
  g.font = '44px system-ui, sans-serif';
  g.fillText(text, 800, 520);
  return 16 / 9;
}
