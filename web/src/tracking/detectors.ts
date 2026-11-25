// MediaPipe: Koerper- und Handerkennung im Browser. Modelle und WebAssembly kommen aus dem Netz.
import { FilesetResolver, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';

export const POSE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task';
export const HAND_MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task';
// Gleiche Version wie das npm-Paket @mediapipe/tasks-vision
export const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';

type Fileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

let fileset: Promise<Fileset> | null = null;
const vision = () => (fileset ??= FilesetResolver.forVisionTasks(WASM_URL));

/** Eine eigene Instanz pro Kamera: im Video-Modus merkt sich das Modell den Verlauf. */
export async function createPoseLandmarker(): Promise<PoseLandmarker> {
  return PoseLandmarker.createFromOptions(await vision(), {
    baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numPoses: 1,
  });
}

export async function createHandLandmarker(): Promise<HandLandmarker> {
  return HandLandmarker.createFromOptions(await vision(), {
    baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numHands: 2,
  });
}
