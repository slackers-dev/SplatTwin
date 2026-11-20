// Zwei-Kamera-Geometrie (3DRecon 1-4): Kalibrierung der relativen Kamerapose
// aus den Gelenkpunkten einer Person und Triangulation der Gelenke.
//
// Konventionen
// - Kamerakoordinaten: x nach rechts, y nach unten, z in Blickrichtung.
// - Normierte Bildkoordinaten n = K^-1 * Pixel, also n = [X/Z, Y/Z].
// - Relative Pose: x_B = R * x_A + T  (R als 3x3 zeilenweise in einem Array).
// Reine Mathematik ohne Abhaengigkeiten, damit sie sich separat testen laesst.

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const norm = (a) => Math.sqrt(dot(a, a));

export const mulMV = (R, v) => [
  R[0] * v[0] + R[1] * v[1] + R[2] * v[2],
  R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
  R[6] * v[0] + R[7] * v[1] + R[8] * v[2],
];
export const mulMtV = (R, v) => [
  R[0] * v[0] + R[3] * v[1] + R[6] * v[2],
  R[1] * v[0] + R[4] * v[1] + R[7] * v[2],
  R[2] * v[0] + R[5] * v[1] + R[8] * v[2],
];
const mulMM = (A, B) => {
  const C = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  }
  return C;
};

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

// Brennweite in Bildhoehen aus dem vertikalen Oeffnungswinkel.
export const focalFromFov = (fovYDeg) => 0.5 / Math.tan((fovYDeg * Math.PI) / 360);

// MediaPipe-Bildpunkt (0..1) -> normierte Bildkoordinaten.
export const normalizePoint = (p, aspect, focal) => [((p.x - 0.5) * aspect) / focal, (p.y - 0.5) / focal];

// Linsenverzeichnung rueckgaengig machen (OpenCV-Modell k1, k2, p1, p2, k3).
// Eingabe: verzeichnete normierte Koordinaten. Das Modell ist nur vorwaerts
// geschlossen loesbar, die Umkehrung laeuft als Fixpunkt-Iteration.
export function undistort(xd, yd, dist) {
  const [k1 = 0, k2 = 0, p1 = 0, p2 = 0, k3 = 0] = dist;
  let x = xd, y = yd;
  for (let i = 0; i < 20; i++) {
    const r2 = x * x + y * y;
    const radial = 1 + r2 * (k1 + r2 * (k2 + r2 * k3));
    const dx = 2 * p1 * x * y + p2 * (r2 + 2 * x * x);
    const dy = p1 * (r2 + 2 * y * y) + 2 * p2 * x * y;
    x = (xd - dx) / radial;
    y = (yd - dy) / radial;
  }
  return [x, y];
}

// Rotationsvektor -> Rotationsmatrix (Rodrigues).
function rodrigues(w) {
  const theta = norm(w);
  if (theta < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [x, y, z] = scale(w, 1 / theta);
  const c = Math.cos(theta), s = Math.sin(theta), t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
}

// Loest A x = b fuer kleine dichte Systeme (Gauss mit Pivotsuche).
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

// Wo steht die Kamera relativ zur Person? Gegeben 3D-Punkte W (Kameraachsen,
// Ursprung in der Huefte) und ihre Bildpunkte n, gesucht t mit n ~ W + t.
// Aus u = (Wx+tx)/(Wz+tz) folgt linear:  tx - u*tz = u*Wz - Wx  (analog fuer v).
export function solveTranslation(W, n) {
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const b = [0, 0, 0];
  const accumulate = (row, rhs) => {
    for (let i = 0; i < 3; i++) {
      b[i] += row[i] * rhs;
      for (let j = 0; j < 3; j++) A[i][j] += row[i] * row[j];
    }
  };
  for (let k = 0; k < W.length; k++) {
    const [u, v] = n[k];
    accumulate([1, 0, -u], u * W[k][2] - W[k][0]);
    accumulate([0, 1, -v], v * W[k][2] - W[k][1]);
  }
  return solveLinear(A, b);
}

// Rotation R mit b ~ R a (Horn 1987, Quaternion als groesster Eigenvektor).
export function hornRotation(a, b) {
  const S = new Array(9).fill(0);
  for (let k = 0; k < a.length; k++) {
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) S[i * 3 + j] += a[k][i] * b[k][j];
  }
  const [Sxx, Sxy, Sxz, Syx, Syy, Syz, Szx, Szy, Szz] = S;
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ];
  // Potenzmethode auf der verschobenen Matrix (alle Eigenwerte positiv).
  const shift = Math.max(...N.map((row) => row.reduce((s, v) => s + Math.abs(v), 0)));
  let q = [1, 0, 0, 0];
  for (let it = 0; it < 2000; it++) {
    const r = N.map((row, i) => row.reduce((s, v, j) => s + v * q[j], 0) + shift * q[i]);
    const len = Math.hypot(...r);
    q = r.map((v) => v / len);
  }
  const [w, x, y, z] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

// Triangulation ueber den Mittelpunkt der kuerzesten Verbindung beider Sehstrahlen.
// Rueckgabe: Punkt in Koordinaten von Kamera A oder null (parallel / hinter der Kamera).
export function triangulate(nA, nB, R, T) {
  const dA = [nA[0], nA[1], 1];
  const dB = mulMtV(R, [nB[0], nB[1], 1]);
  const C = scale(mulMtV(R, T), -1); // Zentrum von Kamera B
  const a = dot(dA, dA), b = dot(dA, dB), c = dot(dB, dB), d = dot(dA, C), e = dot(dB, C);
  const den = a * c - b * b;
  if (den < 1e-9) return null;
  const s = (d * c - b * e) / den;
  const u = (b * d - a * e) / den;
  if (s <= 0 || u <= 0) return null;
  return scale(add(scale(dA, s), add(C, scale(dB, u))), 0.5);
}

// Reprojektionsfehler eines Punktepaars (4 Residuen, normierte Koordinaten).
function residual(nA, nB, R, T) {
  const X = triangulate(nA, nB, R, T);
  if (!X) return [0.1, 0.1, 0.1, 0.1];
  const Y = add(mulMV(R, X), T);
  return [X[0] / X[2] - nA[0], X[1] / X[2] - nA[1], Y[0] / Y[2] - nB[0], Y[1] / Y[2] - nB[1]];
}

// Nichtlineare Minimierung des Reprojektionsfehlers (Levenberg-Marquardt) ueber
// 3 Rotations- und 3 Translationsparameter. Die Laenge von T bleibt fest, weil
// der Massstab aus Bildpunkten allein nicht bestimmbar ist.
function refine(pairs, R0, T0) {
  const len = norm(T0);
  const apply = (R, T, p) => {
    const Tn = add(T, [p[3], p[4], p[5]]);
    return [mulMM(rodrigues([p[0], p[1], p[2]]), R), scale(Tn, len / norm(Tn))];
  };
  const evaluate = (R, T) => {
    const r = [];
    for (const [nA, nB] of pairs) r.push(...residual(nA, nB, R, T));
    return r;
  };
  const cost = (r) => r.reduce((s, v) => s + v * v, 0);

  let R = R0, T = T0;
  let r = evaluate(R, T);
  let c = cost(r);
  let lambda = 1e-3;
  const eps = 1e-6;
  for (let it = 0; it < 40; it++) {
    const J = [];
    for (let k = 0; k < 6; k++) {
      const p = [0, 0, 0, 0, 0, 0];
      p[k] = eps;
      const rk = evaluate(...apply(R, T, p));
      J.push(rk.map((v, i) => (v - r[i]) / eps));
    }
    const JtJ = J.map((ji) => J.map((jj) => ji.reduce((s, v, i) => s + v * jj[i], 0)));
    const g = J.map((ji) => -ji.reduce((s, v, i) => s + v * r[i], 0));
    let improved = false;
    for (let attempt = 0; attempt < 8 && !improved; attempt++) {
      const A = JtJ.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) + 1e-12 : v)));
      const step = solveLinear(A, g);
      if (step) {
        const [Rn, Tn] = apply(R, T, step);
        const rn = evaluate(Rn, Tn);
        const cn = cost(rn);
        if (cn < c) {
          improved = cn < c * (1 - 1e-9);
          R = Rn; T = Tn; r = rn; c = cn;
          lambda /= 3;
          break;
        }
      }
      lambda *= 5;
    }
    if (!improved) break;
  }
  return { R, T, residuals: r };
}

// Kalibrierung aus aufgezeichneten Frames. Jedes Frame enthaelt fuer dieselben
// Gelenke: nA, nB (normierte Bildpunkte) und WA, WB (3D-Schaetzung je Kamera,
// Ursprung in der Huefte, Achsen der jeweiligen Kamera).
export function calibrate(frames) {
  const usable = frames.filter((f) => f.nA.length >= 6);
  if (usable.length < 20) throw new Error('Zu wenige Aufnahmen, in denen beide Kameras die Person sehen.');

  // 1) Startwert Rotation: beide Kameras schaetzen dieselbe Koerperpose,
  //    nur in ihren eigenen Achsen. Die Rotation dazwischen ist die Kamerarotation.
  const R0 = hornRotation(usable.flatMap((f) => f.WA), usable.flatMap((f) => f.WB));

  // 2) Startwert Translation: Position jeder Kamera relativ zur Huefte, pro Frame.
  const Ts = [];
  for (const f of usable) {
    const tA = solveTranslation(f.WA, f.nA);
    const tB = solveTranslation(f.WB, f.nB);
    if (tA && tB && tA[2] > 0 && tB[2] > 0) Ts.push(sub(tB, mulMV(R0, tA)));
  }
  if (Ts.length < 10) throw new Error('Kamerapositionen konnten nicht geschaetzt werden.');
  const T0 = [0, 1, 2].map((i) => median(Ts.map((t) => t[i])));
  if (norm(T0) < 0.05) throw new Error('Die Kameras stehen zu nah beieinander.');

  // 3) Verfeinerung: Reprojektionsfehler minimieren, danach Ausreisser
  //    (z.B. vertauschte Seiten) entfernen und noch einmal.
  let pairs = usable.flatMap((f) => f.nA.map((nA, i) => [nA, f.nB[i]]));
  let fit = refine(pairs, R0, T0);
  const errOf = (res, i) => Math.hypot(res[i * 4], res[i * 4 + 1], res[i * 4 + 2], res[i * 4 + 3]);
  const limit = 3 * median(pairs.map((_, i) => errOf(fit.residuals, i))) + 1e-6;
  pairs = pairs.filter((_, i) => errOf(fit.residuals, i) <= limit);
  fit = refine(pairs, fit.R, fit.T);
  let { R, T } = fit;

  // 4) Massstab: Rumpfstrecken der triangulierten Punkte mit der metrischen
  //    Koerperschaetzung vergleichen.
  const ratios = [];
  for (const f of usable) {
    const X = f.nA.map((nA, i) => triangulate(nA, f.nB[i], R, T));
    let tri = 0, ref = 0;
    for (let i = 0; i < X.length; i++) {
      for (let j = i + 1; j < X.length; j++) {
        if (!X[i] || !X[j]) continue;
        tri += norm(sub(X[i], X[j]));
        ref += norm(sub(f.WA[i], f.WA[j]));
      }
    }
    if (tri > 1e-6) ratios.push(ref / tri);
  }
  if (ratios.length) T = scale(T, median(ratios));

  const rms = Math.sqrt(fit.residuals.reduce((s, v) => s + v * v, 0) / Math.max(1, pairs.length * 2));
  return { R, T, rms, baseline: norm(T), pairs: pairs.length, frames: usable.length };
}
