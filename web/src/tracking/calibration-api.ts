// Schachbrett-Kalibrierung ueber den lokalen Server (splattwin serve): der Server sucht die Ecken
// mit OpenCV und rechnet calibrateCamera.
import type { Intrinsics } from '../contracts';
import type { CamId } from './cameras';

export interface ChessboardView {
  found: boolean;
  accepted: boolean;
  count: number;
  /** gefundene Ecken, 0..1 bezogen auf Breite und Hoehe */
  corners?: [number, number][];
}

async function post<T>(path: string, body?: BodyInit): Promise<T> {
  const res = await fetch(path, { method: 'POST', body });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!data) throw new Error('Server ohne Kalibrierung. Bitte mit «uv run splattwin serve» starten.');
  if (!res.ok) throw new Error(data.error || 'Serverfehler ' + res.status);
  return data;
}

export const postChessboard = (cam: CamId, image: Blob, reset: boolean): Promise<ChessboardView> =>
  post(`/api/chessboard?cam=${cam}${reset ? '&reset=1' : ''}`, image);

export const calibrateCamera = (cam: CamId): Promise<Intrinsics> => post(`/api/calibrate?cam=${cam}`);
