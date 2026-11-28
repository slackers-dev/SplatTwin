import { describe, expect, it } from 'vitest';
import { headCrop, mixFace, mixQuat, quatFromMatrix } from './face';

// Drehung um y (Kopf dreht nach links der Person) als 4x4 spaltenweise, mit Skalierung 3.
function yawMatrix(deg: number, scale = 3): number[] {
  const a = (deg * Math.PI) / 180,
    c = Math.cos(a) * scale,
    s = Math.sin(a) * scale;
  return [c, 0, -s, 0, 0, scale, 0, 0, s, 0, c, 0, 1, 2, -30, 1];
}

describe('Gesicht', () => {
  it('liest die Drehung aus der Matrix (ohne Skalierung und Verschiebung)', () => {
    const q = quatFromMatrix(yawMatrix(30));
    expect(q[1]).toBeCloseTo(Math.sin(Math.PI / 12), 5);
    expect(q[3]).toBeCloseTo(Math.cos(Math.PI / 12), 5);
    expect(quatFromMatrix(yawMatrix(0))).toEqual([0, 0, 0, 1]);
    // auch grosse Drehungen (anderer Zweig der Umrechnung)
    const back = quatFromMatrix(yawMatrix(170));
    expect(Math.abs(back[1])).toBeCloseTo(Math.sin((85 * Math.PI) / 180), 4);
  });

  it('mischt Drehungen auf dem kuerzeren Weg und den Mund linear', () => {
    const a = quatFromMatrix(yawMatrix(0)),
      b = quatFromMatrix(yawMatrix(40));
    const m = mixQuat(a, [-b[0], -b[1], -b[2], -b[3]], 0.5); // gleiche Drehung, anderes Vorzeichen
    expect(m[1]).toBeCloseTo(Math.sin(Math.PI / 18), 2);
    expect(mixFace({ q: a, jaw: 0 }, { q: b, jaw: 1 }, 0.25)!.jaw).toBeCloseTo(0.25);
    expect(mixFace(null, { q: b, jaw: 1 }, 0.5)!.jaw).toBe(1);
  });

  it('schneidet den Kopf aus den Koerperpunkten aus', () => {
    const img = new Array(33).fill({ x: 0.5, y: 0.5, visibility: 1 });
    img[0] = { x: 0.5, y: 0.2, visibility: 1 };
    img[7] = { x: 0.52, y: 0.19, visibility: 1 };
    img[8] = { x: 0.48, y: 0.19, visibility: 1 };
    img[11] = { x: 0.6, y: 0.3, visibility: 1 };
    img[12] = { x: 0.4, y: 0.3, visibility: 1 };
    const c = headCrop(img, 1000, 2000)!;
    expect(c.size).toBeCloseTo(220);
    expect(c.x + c.size / 2).toBeCloseTo(500);
    img[0] = { x: 0.5, y: 0.2, visibility: 0.1 };
    expect(headCrop(img, 1000, 2000)).toBeNull();
  });
});
