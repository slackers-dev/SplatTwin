import { describe, expect, it } from 'vitest';
import { StandingHeight } from './height';

const DT = 1 / 30;
const still = (y: number, n = 10) => new Array(n).fill(y);
const run = (h: StandingHeight, ys: (number | null)[]) => ys.map((y) => h.step(y, DT));

describe('StandingHeight', () => {
  it('misst die Hocke relativ zum Stehen beim Start', () => {
    const h = new StandingHeight();
    const out = run(h, [...still(1.2), 0.8, 1.2]);
    expect(out.at(-2)).toBeCloseTo(-0.4);
    expect(out.at(-1)).toBeCloseTo(0);
  });

  it('wartet mit dem Bezug, bis die Messung ruhig ist (Person kommt ins Bild)', () => {
    const h = new StandingHeight();
    const out = run(h, [1.9, 0.4, 1.5, 0.9, ...still(1.2)]);
    expect(out.slice(0, 4).every((v) => v === null)).toBe(true);
    expect(out.at(-1)).toBeCloseTo(0);
    expect(h.step(0.9, DT)).toBeCloseTo(-0.3);
  });

  it('laesst einen kurzen Sprung gelten', () => {
    const h = new StandingHeight();
    const out = run(h, [...still(1), ...still(1.3, 15), 1]);
    expect(out.at(-2)).toBeCloseTo(0.3);
    expect(out.at(-1)).toBeCloseTo(0);
  });

  it('nimmt ein laengeres hoeheres Stehen als neuen Bezug (Start in der Hocke)', () => {
    const h = new StandingHeight();
    const out = run(h, [...still(0.8), ...still(1.2, 60)]);
    expect(out.at(-1)).toBeCloseTo(0);
    expect(h.step(0.8, DT)).toBeCloseTo(-0.4);
  });

  it('beginnt neu, wenn die Person laenger weg war', () => {
    const h = new StandingHeight();
    run(h, [...still(1.2), ...still(null as never, 40)]);
    expect(h.step(0.7, DT)).toBeNull();
  });
});
