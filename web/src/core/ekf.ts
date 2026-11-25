// Extended Kalman Filter fuer die Fusion mehrerer Kameras (SW09 Tracking + 3DRecon).
//
// Statt zuerst zu triangulieren und dann zu glaetten, haelt der Filter pro Gelenk
// den 3D-Zustand  x = [Position (3), Geschwindigkeit (3)]  in Koordinaten von Kamera A.
// Jede Kamera korrigiert ihn einzeln mit ihrem 2D-Bildpunkt:
//
//   Bewegungsmodell:  Constant Velocity, Unsicherheit = zufaellige Beschleunigung sigmaA
//   Messmodell:       h(x) = Projektion von R p + T auf die Bildebene  (nichtlinear -> EKF,
//                     linearisiert ueber die Jacobi-Matrix H)
//
// Vorteile gegenueber der Triangulation:
// - Die Kameras muessen nicht gleichzeitig aufnehmen: jede Messung wird zu ihrem
//   eigenen Zeitpunkt eingerechnet.
// - Sieht nur eine Kamera ein Gelenk, schraenkt sie den Zustand trotzdem ein.
// - Messungen, die nicht zur Vorhersage passen, werden verworfen (Gating).
import { inverse, type Matrix, mul, transpose, zeros } from './linalg';
import type { Mat3, Vec2, Vec3 } from './vec';

const GATE_2D = 13.8; // Chi-Quadrat, 2 Freiheitsgrade, 99.9 %
const GATE_3D = 16.3; // Chi-Quadrat, 3 Freiheitsgrade, 99.9 %
const MAX_REJECTS = 20; // so viele verworfene Messungen in Folge -> Gelenk neu starten
const LOST_AFTER_MS = 1000; // so lange ohne passende Messung -> Gelenk gilt als verloren
const MONO_SIGMA = 0.1; // Unsicherheit der 3D-Schaetzung einer einzelnen Kamera (m)

export class JointEKF {
  /** [px, py, pz, vx, vy, vz] */
  x: number[] | null = null;
  /** 6x6 Kovarianz */
  P: Matrix | null = null;
  /** Zeitpunkt des Zustands (ms) */
  t = 0;
  rejects = 0;
  lastAccepted = 0;

  get ready(): boolean {
    return this.x !== null;
  }

  init(p: Vec3, t: number, sigma = 0.05): void {
    this.x = [p[0], p[1], p[2], 0, 0, 0];
    this.P = zeros(6, 6);
    for (let i = 0; i < 3; i++) {
      this.P[i][i] = sigma * sigma;
      this.P[i + 3][i + 3] = 1;
    }
    this.t = t;
    this.rejects = 0;
    this.lastAccepted = t;
  }

  drop(): void {
    this.x = null;
    this.P = null;
  }

  /**
   * Vorhersage auf den Zeitpunkt t. dt darf leicht negativ sein, wenn das Bild einer
   * Kamera aelter ist als die letzte Korrektur: dann wird zurueckgerechnet.
   */
  predict(t: number, sigmaA: number): void {
    const dt = (t - this.t) / 1000;
    this.t = t;
    if (dt === 0 || !this.x || !this.P) return;
    const { x, P } = this;
    for (let i = 0; i < 3; i++) x[i] += x[i + 3] * dt;
    // P = F P F^T mit F = [[I, dt I], [0, I]]
    for (let i = 0; i < 3; i++) for (let j = 0; j < 6; j++) P[i][j] += dt * P[i + 3][j];
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) P[i][j] += dt * P[i][j + 3];
    // + Q: Prozessrauschen aus zufaelliger Beschleunigung
    const a = Math.abs(dt),
      q = sigmaA * sigmaA;
    for (let i = 0; i < 3; i++) {
      P[i][i] += (q * a ** 4) / 4;
      P[i][i + 3] += (q * a ** 3) / 2;
      P[i + 3][i] += (q * a ** 3) / 2;
      P[i + 3][i + 3] += q * a * a;
    }
  }

  /**
   * Allgemeine Kalman-Korrektur mit Innovation y, Jacobi-Matrix H und Messrauschen sigma.
   * Verwirft die Messung, wenn sie statistisch nicht zur Vorhersage passt.
   */
  #correct(y: number[], H: Matrix, sigma: number, gate: number): boolean {
    const { x, P } = this;
    if (!x || !P) return false;
    const PHt = mul(P, transpose(H));
    const S = mul(H, PHt);
    for (let i = 0; i < S.length; i++) S[i][i] += sigma * sigma;
    const Sinv = inverse(S);
    if (!Sinv) return false;
    // Mahalanobis-Distanz der Innovation
    let d2 = 0;
    for (let i = 0; i < y.length; i++) for (let j = 0; j < y.length; j++) d2 += y[i] * Sinv[i][j] * y[j];
    if (d2 > gate) return false;

    const K = mul(PHt, Sinv);
    for (let i = 0; i < 6; i++) for (let j = 0; j < y.length; j++) x[i] += K[i][j] * y[j];
    const KH = mul(K, H);
    const next = zeros(6, 6);
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        let s = P[i][j];
        for (let k = 0; k < 6; k++) s -= KH[i][k] * P[k][j];
        next[i][j] = s;
      }
    }
    // symmetrisch halten (Rundungsfehler)
    for (let i = 0; i < 6; i++) for (let j = 0; j < i; j++) next[i][j] = next[j][i] = (next[i][j] + next[j][i]) / 2;
    this.P = next;
    return true;
  }

  /**
   * 2D-Messung einer Kamera: n = normierter Bildpunkt, Kamerapose x_cam = R p + T.
   * sigmaMeters ist die Messunsicherheit am Ort des Gelenks; im Bild wird sie mit der Tiefe kleiner.
   */
  update2D(n: Vec2, R: Mat3, T: Vec3, sigmaMeters: number, scale = 1): boolean {
    if (!this.x) return false;
    const [px, py, pz] = this.x;
    const qx = R[0] * px + R[1] * py + R[2] * pz + T[0];
    const qy = R[3] * px + R[4] * py + R[5] * pz + T[1];
    const qz = R[6] * px + R[7] * py + R[8] * pz + T[2];
    if (qz < 0.1) return false; // hinter der Kamera
    const y = [n[0] - qx / qz, n[1] - qy / qz];
    // Jacobi-Matrix der Projektion nach der Position: (1/qz) [[1, 0, -qx/qz], [0, 1, -qy/qz]] R
    const H = zeros(2, 6);
    for (let j = 0; j < 3; j++) {
      H[0][j] = (R[j] - (qx / qz) * R[6 + j]) / qz;
      H[1][j] = (R[3 + j] - (qy / qz) * R[6 + j]) / qz;
    }
    return this.#correct(y, H, (sigmaMeters / qz) * scale, GATE_2D);
  }

  /** Direkte 3D-Messung (schwache Stuetze aus der Einzelschaetzung einer Kamera). */
  update3D(z: Vec3, sigma: number): boolean {
    if (!this.x) return false;
    const y = [z[0] - this.x[0], z[1] - this.x[1], z[2] - this.x[2]];
    const H = zeros(3, 6);
    H[0][0] = H[1][1] = H[2][2] = 1;
    return this.#correct(y, H, sigma, GATE_3D);
  }
}

/** Beobachtung eines Gelenks durch eine Kamera. */
export interface JointObservation {
  /** normierter, entzerrter Bildpunkt */
  n: Vec2;
  /** Sichtbarkeit laut Erkennung, 0..1 */
  vis: number;
  /** 3D-Schaetzung dieser Kamera relativ zur Huefte, in den Achsen von Kamera A */
  mono: Vec3;
}

export interface EKFParams {
  sigmaA: number;
  sigmaZ: number;
  /** Startpunkt fuer noch unbekannte Gelenke (z.B. aus der Triangulation) */
  init?: ((i: number) => Vec3 | null | undefined) | null;
}

export class SkeletonEKF {
  joints: JointEKF[];
  /** Position der Huefte in Kamera A (aus der letzten Korrektur) */
  offset: Vec3 | null = null;
  /** verworfene Messungen der letzten Korrektur */
  rejected = 0;

  constructor(count = 33) {
    this.joints = Array.from({ length: count }, () => new JointEKF());
  }

  reset(): void {
    this.joints.forEach((j) => j.drop());
    this.offset = null;
  }

  positions(): (Vec3 | null)[] {
    return this.joints.map((j) => (j.x ? [j.x[0], j.x[1], j.x[2]] : null));
  }

  /**
   * Rechnet die Beobachtungen EINER Kamera zum Zeitpunkt t ein.
   * R, T: Pose der Kamera (x_cam = R p + T), fuer Kamera A die Identitaet.
   */
  updateCamera(t: number, obs: (JointObservation | null)[], R: Mat3, T: Vec3, { sigmaA, sigmaZ, init = null }: EKFParams): this {
    this.rejected = 0;
    for (const j of this.joints) if (j.ready) j.predict(t, sigmaA);

    // Wo liegt die Huefte? Mittel aus (Zustand - Einzelschaetzung) ueber alle bekannten Gelenke.
    let sum: Vec3 = [0, 0, 0],
      count = 0;
    this.joints.forEach((j, i) => {
      const m = obs[i]?.mono;
      if (!j.x || !m) return;
      sum = [sum[0] + j.x[0] - m[0], sum[1] + j.x[1] - m[1], sum[2] + j.x[2] - m[2]];
      count++;
    });
    const off: Vec3 | null = count >= 3 ? [sum[0] / count, sum[1] / count, sum[2] / count] : null;

    this.joints.forEach((j, i) => {
      const o = obs[i];
      const guess: Vec3 | null = o?.mono && off ? [o.mono[0] + off[0], o.mono[1] + off[1], o.mono[2] + off[2]] : null;
      if (!j.ready) {
        const start = init?.(i) ?? guess;
        if (start) j.init(start, t);
        return;
      }
      if (o?.n) {
        const accepted = j.update2D(o.n, R, T, sigmaZ, 1 / Math.max(o.vis ?? 1, 0.3));
        if (accepted) {
          j.rejects = 0;
          j.lastAccepted = t;
          // Die 3D-Einzelschaetzung haelt die Tiefe, wenn nur eine Kamera das Gelenk sieht.
          if (guess) j.update3D(guess, Math.max(MONO_SIGMA, 4 * sigmaZ));
        } else {
          j.rejects++;
          this.rejected++;
        }
      }
      if (j.rejects > MAX_REJECTS || t - j.lastAccepted > LOST_AFTER_MS) j.drop();
    });

    if (off) this.offset = off;
    return this;
  }
}
