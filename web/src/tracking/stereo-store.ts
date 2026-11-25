// Gespeicherte Stereo-Kalibrierung. Sie gilt nur, solange die Kameras nicht bewegt wurden.
import type { StereoCalibration } from '../core/stereo';
import { loadJson, removeKey, saveJson } from '../ui/storage';

const KEY = 'cvai-stereo-calib';

export interface SavedStereo extends Pick<StereoCalibration, 'R' | 'T' | 'rms' | 'baseline'> {
  fovA?: number;
  fovB?: number;
}

export function loadStereo(): SavedStereo | null {
  const saved = loadJson<SavedStereo>(KEY);
  return saved?.R?.length === 9 && saved?.T?.length === 3 ? saved : null;
}

export const saveStereo = (s: SavedStereo): void => saveJson(KEY, s);
export const clearStereo = (): void => removeKey(KEY);
