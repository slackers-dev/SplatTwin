// Prueft pro Kamera, ob eine Person da ist, ob sie ganz im Bild ist und wohin sie schaut.
import { LM, type Landmark } from '../core/landmarks';
import { shoulderYaw } from '../core/turn';

export type CaptureMode = 'body' | 'face';

export interface PersonState {
  present: boolean;
  /** gut im Bild fuer den aktuellen Modus */
  full: boolean;
  /** leer = gut, sonst der Grund */
  hint: string;
  /** Blickrichtung in Grad, 0 = schaut in die Kamera */
  yaw: number | null;
  /** Schultermitte im Bild (0..1), auch in der Nahaufnahme sichtbar */
  center: [number, number] | null;
  img: Landmark[] | null;
}

export const emptyState = (): PersonState => ({ present: false, full: false, hint: '', yaw: null, center: null, img: null });

export function analyse(img: Landmark[] | undefined, world: Landmark[] | undefined, mode: CaptureMode): PersonState {
  const s = emptyState();
  const seen = (i: number, min = 0.5) => {
    const p = img![i]!;
    return (p.visibility ?? 1) >= min && p.x > 0.01 && p.x < 0.99 && p.y > 0.01 && p.y < 0.99;
  };
  s.present = !!img && [LM.nose, LM.lSh, LM.rSh, LM.lHip, LM.rHip].filter((i) => (img[i]!.visibility ?? 1) > 0.5).length >= 2;
  if (!s.present || !img || !world) return { ...s, present: s.present && !!img && !!world };
  s.img = img;
  const nose = img[LM.nose]!,
    lSh = img[LM.lSh]!,
    rSh = img[LM.rSh]!;
  // Kopfgroesse im Bild: Abstand Nase bis Schulterlinie, als Anteil der Bildhoehe.
  const shY = (lSh.y + rSh.y) / 2;
  const head = shY - nose.y;
  if (mode === 'face') {
    s.hint = !seen(LM.nose)
      ? 'Kopf nicht im Bild'
      : nose.y - 0.9 * head < 0.02
        ? 'Kopf oben abgeschnitten, etwas zurück'
        : head < 0.16
          ? 'Näher kommen'
          : '';
  } else {
    s.hint = !seen(LM.nose)
      ? 'Kopf nicht im Bild'
      : !(seen(LM.lAn, 0.3) && seen(LM.rAn, 0.3))
        ? 'Füsse nicht im Bild'
        : !(seen(LM.lWr, 0.3) || seen(LM.rWr, 0.3))
          ? 'Hände nicht im Bild'
          : '';
  }
  s.full = !s.hint;
  s.center = [(lSh.x + rSh.x) / 2, shY];
  s.yaw = shoulderYaw(world);
  return s;
}
