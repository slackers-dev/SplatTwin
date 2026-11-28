// Koerper- und Handerkennung einer Kamera in einem eigenen Hintergrund-Strang (Web Worker).
// So rechnen beide Kameras gleichzeitig, und das Zeichnen der Szene wartet nicht auf MediaPipe.
//
// Muss ein klassischer Worker sein (kein Modul): MediaPipe laedt seinen WebAssembly-Teil mit
// importScripts, das es in Modul-Workern nicht gibt. Vite baut Worker standardmaessig klassisch.
import type { HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { DetectRequest, DetectResponse } from './detection';
import { createHandLandmarker, createPoseLandmarker } from './detectors';

// Ohne die Typen der Worker-Umgebung (die wuerden die DOM-Typen der Seiten ueberlagern):
// nur das, was hier gebraucht wird.
interface WorkerScope {
  onmessage: ((e: MessageEvent<DetectRequest>) => void) | null;
  postMessage(msg: DetectResponse, transfer: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;
let pose: PoseLandmarker | null = null;
let hands: HandLandmarker | null = null;

const reply = (msg: DetectResponse, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);

scope.onmessage = async (e: MessageEvent<DetectRequest>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    try {
      // Ohne Seite gibt es kein Canvas: die GPU bekommt MediaPipe ueber ein OffscreenCanvas.
      [pose, hands] = await Promise.all([
        createPoseLandmarker(msg.variant, new OffscreenCanvas(1, 1), msg.delegate),
        createHandLandmarker(new OffscreenCanvas(1, 1), msg.delegate),
      ]);
      reply({ type: 'ready' });
    } catch (err) {
      reply({ type: 'error', error: String((err as Error)?.message ?? err) });
    }
    return;
  }
  const { frame, t, fingers } = msg;
  try {
    const start = performance.now();
    const p = pose!.detectForVideo(frame, t);
    const h = fingers ? hands!.detectForVideo(frame, t) : null;
    reply({
      type: 'result',
      t,
      img: p.landmarks?.[0] ?? null,
      world: p.worldLandmarks?.[0] ?? null,
      hands: h ? { landmarks: h.landmarks, worldLandmarks: h.worldLandmarks } : null,
      ms: performance.now() - start,
    });
  } catch (err) {
    reply({ type: 'error', error: String((err as Error)?.message ?? err) });
  } finally {
    frame.close();
  }
};
