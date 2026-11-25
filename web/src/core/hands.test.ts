import { describe, expect, it } from 'vitest';
import { assignHands } from './hands';
import { LM } from './landmarks';
import { landmark } from './testing';

const hand = (x: number, y: number) => Array.from({ length: 21 }, () => landmark([x, y, 0]));

describe('assignHands', () => {
  const img = Array.from({ length: 33 }, () => landmark([0.5, 0.5, 0]));
  img[LM.lWr] = landmark([0.7, 0.6, 0]);
  img[LM.rWr] = landmark([0.3, 0.6, 0]);

  it('ordnet Haende dem naechsten Handgelenk zu, unabhaengig von der Reihenfolge', () => {
    const out = assignHands({ landmarks: [hand(0.31, 0.6), hand(0.69, 0.61)], worldLandmarks: [hand(1, 0), hand(2, 0)] }, img);
    expect(out.Right?.[0][0]).toBe(1);
    expect(out.Left?.[0][0]).toBe(2);
  });

  it('laesst Haende weg, die zu keinem Handgelenk passen', () => {
    const out = assignHands({ landmarks: [hand(0.5, 0.1)], worldLandmarks: [hand(1, 0)] }, img);
    expect(out).toEqual({ Left: null, Right: null });
  });
});
