// Takt fuer das Tracking, auch wenn Chrome das Fenster bremst.
//
// requestAnimationFrame laeuft nur so oft, wie das Fenster gezeichnet wird. Verdeckt ein anderes Fenster
// die Tracking-Seite (z. B. die Buehne auf demselben Rechner), drosselt Chrome es auf etwa 1 Bild pro
// Sekunde: Auf der Buehne kamen dann zu wenige Bilder an, der Presenter fiel immer wieder raus.
// Timer in einem Worker drosselt Chrome dabei nicht. Der Worker schickt alle 1000/hz ms einen Takt; die
// Seite rechnet dann einen Tracking-Schritt, falls die Animationsschleife zu lange nichts mehr getan hat.
const WORKER = `let id; onmessage = (e) => { clearInterval(id); if (e.data > 0) id = setInterval(() => postMessage(0), e.data); };`;

export function startTicker(hz: number, tick: () => void): () => void {
  let worker: Worker | null = null;
  try {
    worker = new Worker(URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' })));
  } catch {
    // Ohne Worker (z. B. gesperrt): Timer im Hauptstrang, gedrosselt, aber besser als nichts.
    const id = setInterval(tick, 1000 / hz);
    return () => clearInterval(id);
  }
  worker.onmessage = tick;
  worker.postMessage(1000 / hz);
  return () => worker.terminate();
}
