// Kalman-Filter mit Constant-Velocity-Modell fuer einen 3D-Punkt (SW09 Tracking).
//
// Zustand pro Achse:  x = [Position, Geschwindigkeit]
// Systemmodell:       F = [[1, dt], [0, 1]], Prozessrauschen aus zufaelliger Beschleunigung (sigmaA)
// Messmodell:         H = [1, 0], Messrauschen sigmaZ
//
// Die drei Achsen sind unabhaengig und haben dieselben Parameter, deshalb
// teilen sie sich eine einzige 2x2-Kovarianzmatrix P.
import type { Vec3 } from './vec';

export class KalmanPoint {
  /** Position, null solange noch nie gemessen wurde. */
  p: Vec3 | null = null;
  v: Vec3 = [0, 0, 0];
  /** Kovarianz [[a, b], [c, d]] */
  P: [number, number, number, number] = [1, 0, 0, 1];

  reset(): void {
    this.p = null;
  }

  /**
   * z: Messung oder null (keine Messung -> nur Vorhersage).
   * Rueckgabe: gefilterte Position oder null, solange noch nie gemessen wurde.
   */
  step(z: Vec3 | null, dt: number, sigmaA: number, sigmaZ: number): Vec3 | null {
    if (!this.p) {
      if (!z) return null;
      this.p = [z[0], z[1], z[2]];
      this.v = [0, 0, 0];
      this.P = [sigmaZ * sigmaZ, 0, 0, 1];
      return this.p;
    }

    // --- Vorhersage: x = F x,  P = F P F^T + Q
    for (let i = 0; i < 3; i++) this.p[i] += this.v[i] * dt;
    let [a, b, c, d] = this.P;
    const q = sigmaA * sigmaA;
    const dt2 = dt * dt;
    a = a + dt * (b + c) + dt2 * d + (q * dt2 * dt2) / 4;
    b = b + dt * d + (q * dt2 * dt) / 2;
    c = c + dt * d + (q * dt2 * dt) / 2;
    d = d + q * dt2;

    if (!z) {
      // Ohne Messung laeuft der Punkt mit abklingender Geschwindigkeit weiter.
      for (let i = 0; i < 3; i++) this.v[i] *= 0.85;
      this.P = [Math.min(a, 1), b, c, Math.min(d, 10)];
      return this.p;
    }

    // --- Korrektur: K = P H^T / (H P H^T + R)
    const S = a + sigmaZ * sigmaZ;
    const k0 = a / S;
    const k1 = c / S;
    for (let i = 0; i < 3; i++) {
      const y = z[i] - this.p[i]; // Innovation
      this.p[i] += k0 * y;
      this.v[i] += k1 * y;
    }
    this.P = [(1 - k0) * a, (1 - k0) * b, c - k1 * a, d - k1 * b];
    return this.p;
  }
}
