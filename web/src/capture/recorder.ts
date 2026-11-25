// Video im Browser aufnehmen und an den Server schicken (der wandelt es in MP4 mit festen 30 fps um).
import type { SavedVideo } from '../contracts';

export const MIME = ['video/mp4;codecs=avc1.640028', 'video/webm;codecs=vp9', 'video/webm'].find((m) =>
  MediaRecorder.isTypeSupported(m),
)!;

export interface Recording {
  rec: MediaRecorder;
  /** performance.now() beim Start, null bis der Rekorder laeuft */
  startedAt: number | null;
  done: Promise<Blob>;
}

export function record(stream: MediaStream): Recording {
  const rec = new MediaRecorder(stream, { mimeType: MIME, videoBitsPerSecond: 16_000_000 });
  const chunks: Blob[] = [];
  const state: Recording = {
    rec,
    startedAt: null,
    done: new Promise((resolve) => rec.addEventListener('stop', () => resolve(new Blob(chunks, { type: MIME })))),
  };
  rec.addEventListener('start', () => (state.startedAt = performance.now()));
  rec.addEventListener('dataavailable', (e) => chunks.push(e.data));
  rec.start(1000);
  return state;
}

/** rot: Grad, um die der Server das Video aufrichtet (hochkant stehendes Handy). */
export async function upload(name: string, cam: string, blob: Blob, rot: number): Promise<SavedVideo> {
  const kind = MIME.startsWith('video/mp4') ? 'mp4' : 'webm';
  const r = await fetch(`/api/capture?name=${name}&cam=${cam}&kind=${kind}&rot=${rot}`, { method: 'POST', body: blob });
  const info = (await r.json()) as SavedVideo & { error?: string };
  if (!r.ok) throw new Error(info.error);
  return info;
}

export async function saveMeta(name: string, meta: object): Promise<void> {
  const r = await fetch(`/api/capture?name=${name}&cam=a&kind=json`, { method: 'POST', body: JSON.stringify(meta, null, 1) });
  if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? 'Metadatei nicht gespeichert');
}
