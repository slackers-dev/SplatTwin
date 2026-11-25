import { describe, expect, it } from 'vitest';
import { inverse, mul, solve } from './linalg';

describe('linalg', () => {
  const M = [[4, 1, 0], [1, 3, 1], [0, 1, 2]];

  it('inverse mal Matrix ist die Einheitsmatrix', () => {
    const I = mul(inverse(M)!, M);
    I.forEach((row, i) => row.forEach((v, j) => expect(v).toBeCloseTo(i === j ? 1 : 0, 12)));
  });

  it('loest A x = b', () => {
    const x = solve(M, [1, 2, 3])!;
    mul(M, x.map((v) => [v])).forEach(([v], i) => expect(v).toBeCloseTo([1, 2, 3][i], 12));
  });

  it('erkennt singulaere Matrizen', () => {
    expect(inverse([[1, 2], [2, 4]])).toBeNull();
    expect(solve([[1, 2], [2, 4]], [1, 1])).toBeNull();
  });
});
