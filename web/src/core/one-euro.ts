// One-Euro-Filter (Casiez, Roussel, Vogel 2012): adaptive Glaettung fuer zitternde Messpunkte.
//
// Ein Tiefpass, dessen Grenzfrequenz mit der Geschwindigkeit steigt:
//   cutoff = minCutoff + beta * |Geschwindigkeit|
// In Ruhe glaettet er stark (kein Zittern), bei schneller Bewegung kaum (wenig Verzoegerung).
// Ein Kalman-Filter mit festen Parametern muss sich dagegen fuer einen Kompromiss entscheiden.
// Hier laeuft er als letzte Stufe nach Kalman bzw. EKF.
import type { Vec3 } from './vec';

export interface OneEuroParams {
  /** Grenzfrequenz in Ruhe (Hz): kleiner = ruhiger, aber traeger */
  minCutoff: number;
  /** wie stark die Grenzfrequenz mit der Geschwindigkeit (m/s) steigt */
  beta: number;
  /** Grenzfrequenz fuer die Geschwindigkeitsschaetzung (Hz) */
  dCutoff?: number;
}

/** Glaettungsfaktor eines Tiefpasses erster Ordnung fuer Grenzfrequenz fc und Zeitschritt dt. */
const alpha = (fc: number, dt: number): number => {
  const tau = 1 / (2 * Math.PI * fc);
  return 1 / (1 + tau / dt);
};

export class OneEuroPoint {
  private x: Vec3 | null = null;
  private dx: Vec3 = [0, 0, 0];

  reset(): void {
    this.x = null;
    this.dx = [0, 0, 0];
  }

  /** p: neuer Punkt oder null (dann wird der Filter zurueckgesetzt). dt in Sekunden. */
  step(p: Vec3 | null, dt: number, { minCutoff, beta, dCutoff = 1 }: OneEuroParams): Vec3 | null {
    if (!p) {
      this.reset();
      return null;
    }
    if (!this.x || dt <= 0) {
      this.x = [p[0], p[1], p[2]];
      return this.x;
    }
    const prev = this.x;
    // Geschwindigkeit geglaettet schaetzen, ihre Laenge steuert die Grenzfrequenz.
    const aD = alpha(dCutoff, dt);
    this.dx = [0, 1, 2].map((i) => this.dx[i] + aD * ((p[i] - prev[i]) / dt - this.dx[i])) as Vec3;
    const speed = Math.hypot(...this.dx);
    const a = alpha(minCutoff + beta * speed, dt);
    this.x = [0, 1, 2].map((i) => prev[i] + a * (p[i] - prev[i])) as Vec3;
    return this.x;
  }
}

/** Glaettung von 0 (aus) bis 1 (sehr ruhig) -> Parameter. Werte durch Ausprobieren gewaehlt. */
export function smoothingParams(level: number): OneEuroParams | null {
  if (level <= 0) return null;
  const l = Math.min(1, level);
  // minCutoff von 4 Hz (kaum) bis 0.3 Hz (stark), logarithmisch. beta sinkt mit: bei starker
  // Glaettung reagiert der Filter erst auf deutlichere Bewegung.
  const minCutoff = 4 * Math.pow(0.3 / 4, l);
  return { minCutoff, beta: 4 - 3 * l, dCutoff: 1 };
}

/** Eine Gruppe von Punkten (Skelett oder Hand) mit je einem Filter. */
export class OneEuroGroup {
  private readonly filters: OneEuroPoint[];

  constructor(count: number) {
    this.filters = Array.from({ length: count }, () => new OneEuroPoint());
  }

  reset(): void {
    this.filters.forEach((f) => f.reset());
  }

  step(points: (Vec3 | null)[] | null, dt: number, params: OneEuroParams | null): (Vec3 | null)[] | null {
    if (!points) {
      this.reset();
      return null;
    }
    if (!params) return points;
    return points.map((p, i) => this.filters[i]!.step(p, dt, params));
  }
}
