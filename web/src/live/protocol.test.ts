import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LiveFrame } from '../contracts';
import { BODY, decodeFrame, encodeFrame } from './protocol';

const example = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../contracts/examples/live-frame.json'), 'utf8')) as LiveFrame;

const maxError = (a: LiveFrame['pts'], b: LiveFrame['pts']) =>
  Math.max(0, ...a.flatMap((p, i) => (p ? p.map((x, k) => Math.abs(x - b[i]![k]!)) : [b[i] === null ? 0 : Infinity])));

describe('Bildformat der Buehne', () => {
  it('packt das Beispiel aus contracts/ verlustarm ein und aus', () => {
    const buf = encodeFrame({ ...example, hands: { Left: example.hands.Left, Right: example.hands.Right } });
    const back = decodeFrame(buf);
    expect(back.t).toBe(Math.round(example.t));
    expect(back.upper).toBe(example.upper);
    expect(back.pos[0]).toBeCloseTo(example.pos[0]!, 3);
    expect(back.height).toBeCloseTo(example.height!, 3);
    // Kopf und Mund: 9 Bytes, Drehung auf 1/32767 genau
    back.face!.q.forEach((x, k) => expect(x).toBeCloseTo(example.face!.q[k]!, 4));
    expect(back.face!.jaw).toBeCloseTo(example.face!.jaw, 2);
    // Nur die Gelenke, die der Avatar braucht, kommen an; Fehler hoechstens 0,05 mm.
    const used = example.pts.map((p, i) => ((BODY as readonly number[]).includes(i) ? p : null));
    expect(maxError(used, back.pts)).toBeLessThanOrEqual(0.00005);
  });

  it('ist klein: 118 Bytes ohne, 370 Bytes mit beiden Haenden', () => {
    const pts = Array.from({ length: 33 }, (_, i) => [i / 100, -i / 50, 0.1] as [number, number, number]);
    const hand = Array.from({ length: 21 }, (_, i) => [i / 1000, 0, -i / 1000] as [number, number, number]);
    const base = { t: 1, upper: false, mirror: false, pos: [0, 0] as [number, number], height: null, face: null, pts };
    expect(encodeFrame({ ...base, hands: { Left: null, Right: null } }).byteLength).toBe(118);
    expect(encodeFrame({ ...base, hands: { Left: hand, Right: hand } }).byteLength).toBe(370);
  });

  it('laesst fehlende Gelenke und unvollstaendige Haende weg', () => {
    const pts: ([number, number, number] | null)[] = new Array(33).fill(null);
    pts[11] = [0.2, 0.5, 0];
    const halfHand = [[0, 0, 0], null];
    const buf = encodeFrame({ t: 5, upper: true, mirror: true, pos: [1.5, -2], height: null, face: null, pts, hands: { Left: halfHand as never, Right: null } });
    const back = decodeFrame(buf);
    expect(buf.byteLength).toBe(16 + 6);
    expect(back.height).toBeNull();
    expect(back.pts[11]).toEqual([0.2, 0.5, 0]);
    expect(back.pts[12]).toBeNull();
    expect(back.hands).toEqual({ Left: null, Right: null });
    expect([back.upper, back.mirror, back.pos]).toEqual([true, true, [1.5, -2]]);
  });

  it('liest hinter dem Byte mit dem Platz, das der Server davorstellt', () => {
    const pts = new Array(33).fill(null);
    pts[0] = [0, 0.66, 0.1];
    const buf = encodeFrame({ t: 9, upper: false, mirror: false, pos: [0, 0], height: null, face: null, pts, hands: { Left: null, Right: null } });
    const withSlot = new Uint8Array(buf.byteLength + 1);
    withSlot[0] = 1;
    withSlot.set(new Uint8Array(buf), 1);
    expect(decodeFrame(withSlot.buffer, 1).pts[0]).toEqual([0, 0.66, 0.1]);
  });
});
