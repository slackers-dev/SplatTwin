// Empfaengt die Bilder der Tracking-Seite als Server-Sent Events.
import type { LiveFrame } from '../contracts';

/** Ruft onFrame fuer jedes Bild auf. Rueckgabe: Funktion zum Beenden. */
export function subscribeLive(onFrame: (frame: LiveFrame) => void, onError: () => void): () => void {
  const source = new EventSource('/api/live');
  source.onmessage = (e: MessageEvent<string>) => onFrame(JSON.parse(e.data) as LiveFrame);
  source.onerror = onError;
  return () => source.close();
}
