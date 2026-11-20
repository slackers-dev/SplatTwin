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

const GATE_2D = 13.8;        // Chi-Quadrat, 2 Freiheitsgrade, 99.9 %
const GATE_3D = 16.3;        // Chi-Quadrat, 3 Freiheitsgrade, 99.9 %
const MAX_REJECTS = 20;      // so viele verworfene Messungen in Folge -> Gelenk neu starten
const LOST_AFTER_MS = 1000;  // so lange ohne passende Messung -> Gelenk gilt als verloren
const MONO_SIGMA = 0.10;     // Unsicherheit der 3D-Schaetzung einer einzelnen Kamera (m)

const zeros = (r, c) => Array.from({ length: r }, () => new Array(c).fill(0));
const mul = (A, B) => A.map((row) => B[0].map((_, j) => row.reduce((s, v, k) => s + v * B[k][j], 0)));
const transpose = (A) => A[0].map((_, j) => A.map((row) => row[j]));

// Inverse einer kleinen Matrix (Gauss-Jordan), null falls singulaer.
function inverse(M) {
  const n = M.length;
  const A = M.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-15) return null;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c];
    for (let k = 0; k < 2 * n; k++) A[c][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c];
      for (let k = 0; k < 2 * n; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row) => row.slice(n));
}

export class JointEKF {
  constructor() {
    this.x = null;      // [px, py, pz, vx, vy, vz]
    this.P = null;      // 6x6 Kovarianz
    this.t = 0;         // Zeitpunkt des Zustands (ms)
    this.rejects = 0;
    this.lastAccepted = 0;
  }

  get ready() {
    return this.x !== null;
  }

  init(p, t, sigma = 0.05) {
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

  drop() {
    this.x = null;
    this.P = null;
  }

  // Vorhersage auf den Zeitpunkt t. dt darf leicht negativ sein, wenn das Bild einer
  // Kamera aelter ist als die letzte Korrektur: dann wird zurueckgerechnet.
  predict(t, sigmaA) {
    const dt = (t - this.t) / 1000;
    this.t = t;
    if (dt === 0) return;
    const { x, P } = this;
    for (let i = 0; i < 3; i++) x[i] += x[i + 3] * dt;
    // P = F P F^T mit F = [[I, dt I], [0, I]]
    for (let i = 0; i < 3; i++) for (let j = 0; j < 6; j++) P[i][j] += dt * P[i + 3][j];
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) P[i][j] += dt * P[i][j + 3];
    // + Q: Prozessrauschen aus zufaelliger Beschleunigung
    const a = Math.abs(dt), q = sigmaA * sigmaA;
    for (let i = 0; i < 3; i++) {
      P[i][i] += (q * a ** 4) / 4;
      P[i][i + 3] += (q * a ** 3) / 2;
      P[i + 3][i] += (q * a ** 3) / 2;
      P[i + 3][i + 3] += q * a * a;
    }
  }

  // Allgemeine Kalman-Korrektur mit Innovation y, Jacobi-Matrix H und Messrauschen sigma.
  // Verwirft die Messung, wenn sie statistisch nicht zur Vorhersage passt.
  #correct(y, H, sigma, gate) {
    const { x, P } = this;
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

  // 2D-Messung einer Kamera: n = normierter Bildpunkt, Kamerapose x_cam = R p + T.
  // sigmaMeters ist die Messunsicherheit am Ort des Gelenks; im Bild wird sie mit der Tiefe kleiner.
  update2D(n, R, T, sigmaMeters, scale = 1) {
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

  // Direkte 3D-Messung (schwache Stuetze aus der Einzelschaetzung einer Kamera).
  update3D(z, sigma) {
    const y = [z[0] - this.x[0], z[1] - this.x[1], z[2] - this.x[2]];
    const H = zeros(3, 6);
    H[0][0] = H[1][1] = H[2][2] = 1;
    return this.#correct(y, H, sigma, GATE_3D);
  }
}

export class SkeletonEKF {
  constructor(count = 33) {
    this.joints = Array.from({ length: count }, () => new JointEKF());
    this.offset = null;   // Position der Huefte in Kamera A (aus der letzten Korrektur)
    this.rejected = 0;    // verworfene Messungen der letzten Korrektur
  }

  reset() {
    this.joints.forEach((j) => j.drop());
    this.offset = null;
  }

  positions() {
    return this.joints.map((j) => (j.ready ? [j.x[0], j.x[1], j.x[2]] : null));
  }

  // Rechnet die Beobachtungen EINER Kamera zum Zeitpunkt t ein.
  // obs[i] = { n: [x, y] | null, vis, mono: [x, y, z] | null }
  //   n    normierter, entzerrter Bildpunkt
  //   mono 3D-Schaetzung dieser Kamera relativ zur Huefte, in den Achsen von Kamera A
  // R, T   Pose der Kamera (x_cam = R p + T), fuer Kamera A die Identitaet
  // init   liefert einen Startpunkt fuer noch unbekannte Gelenke (z.B. Triangulation)
  updateCamera(t, obs, R, T, { sigmaA, sigmaZ, init = null }) {
    this.rejected = 0;
    for (const j of this.joints) if (j.ready) j.predict(t, sigmaA);

    // Wo liegt die Huefte? Mittel aus (Zustand - Einzelschaetzung) ueber alle bekannten Gelenke.
    let off = [0, 0, 0], count = 0;
    this.joints.forEach((j, i) => {
      const m = obs[i]?.mono;
      if (!j.ready || !m) return;
      off = [off[0] + j.x[0] - m[0], off[1] + j.x[1] - m[1], off[2] + j.x[2] - m[2]];
      count++;
    });
    off = count >= 3 ? off.map((v) => v / count) : null;

    this.joints.forEach((j, i) => {
      const o = obs[i];
      const guess = o?.mono && off ? [o.mono[0] + off[0], o.mono[1] + off[1], o.mono[2] + off[2]] : null;
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
