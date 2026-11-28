import { describe, expect, it } from 'vitest';
import { LM } from './landmarks';
import { type CameraModel, estimateRoot, measureMono, measureStereo, okJoint } from './measure';
import { normalizePoint } from './stereo';
import { landmark, project, skeleton, toB, yaw } from './testing';
import { add, mulMV, type Vec3 } from './vec';

const aspect = 16 / 9;
const focal = 1.2; // in Bildhoehen
const cam: CameraModel = { aspect, focal, normalize: (p) => normalizePoint(p, aspect, focal) };

/** Bildpunkt (0..1) einer Kamera mit diesem Modell. */
const toImage = (p: Vec3) => {
  const [u, v] = project(p);
  return landmark([(u * focal) / aspect + 0.5, v * focal + 0.5, 0]);
};

describe('measure', () => {
  const body = skeleton();
  const world = body.map((p) => landmark(p));

  it('schaetzt die Entfernung mit dem Lochkamera-Modell', () => {
    const hip: Vec3 = [0.4, 0, 3.2];
    const img = body.map((p) => toImage(add(hip, p)));
    const root = estimateRoot(img, world, cam)!;
    expect(-root[2]).toBeCloseTo(3.2, 1);
    expect(root[0]).toBeCloseTo(0.4, 1);
  });

  // Hoehe der Huefte im Raum (Achsen des Avatars, y oben) fuer eine Person mit Huefte bei hip.
  const height = (hip: Vec3, pose = body, crop = 1.01) => {
    const img = pose.map((p) => toImage(add(hip, p))).map((l) => (l.y > crop ? { ...l, y: 2 } : l));
    return estimateRoot(img, pose.map((p) => landmark(p)), cam)![1];
  };

  it('misst die Hoehe der Huefte: in die Knie gehen senkt sie', () => {
    const stand = height([0.1, 0.2, 3]);
    const squat = height([0.1, 0.6, 3]); // Kamerakoordinaten: y nach unten
    expect(stand - squat).toBeCloseTo(0.4, 2);
  });

  it('haelt die Hoehe beim Vorbeugen (Schultern tiefer, Huefte gleich)', () => {
    const bow = body.map((p): Vec3 => (p[1] < -0.2 ? [p[0], p[1] * 0.6, p[2] - 0.3] : p));
    expect(Math.abs(height([0, 0.2, 3], bow) - height([0, 0.2, 3]))).toBeLessThan(0.015);
  });

  it('misst die Hoehe auch ohne Huefte im Bild (Laptop: nur Oberkoerper)', () => {
    // Nur das obere Bild: Huefte und Beine liegen ausserhalb.
    const crop = 0.8;
    const stand = height([0, 0.6, 2], body, crop);
    const squat = height([0, 0.9, 2], body, crop);
    expect(stand - squat).toBeCloseTo(0.3, 2);
  });

  it('nimmt Gelenke ausserhalb des Bildes nicht', () => {
    const img = body.map(() => landmark([1.5, 0.5, 0]));
    expect(okJoint(world, img, LM.lWr)).toBe(false);
    expect(measureMono(world, img, cam).pts.every((p) => p === null)).toBe(true);
  });

  it('trianguliert mit zwei Kameras die echte Position', () => {
    const R = yaw(-30);
    const T: Vec3 = [1, 0, 0.2];
    const hip: Vec3 = [0.2, 0.1, 3];
    const XA = body.map((p) => add(hip, p));
    const imgA = XA.map(toImage);
    const imgB = XA.map((X) => toImage(toB(X, R, T)));
    const worldB = body.map((p) => landmark(mulMV(R, p))); // Weltpunkte in den Achsen von Kamera B
    const m = measureStereo(world, imgA, worldB, imgB, { R, T }, cam, cam)!;
    expect(m.nTri).toBeGreaterThan(20);
    expect(m.root![0]).toBeCloseTo(0.2, 6);
    expect(-m.root![2]).toBeCloseTo(3, 6);
    // Relativ zur Huefte, Achsen des Avatars (y oben)
    expect(m.pts[LM.nose]![1]).toBeCloseTo(0.65, 6);
  });
});
