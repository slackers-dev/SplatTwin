// Rektifizierte Ansicht beider Kameras (3DRecon 2-3): beide Bilder rechnerisch so gedreht, als
// stuenden die Kameras parallel nebeneinander. Dann liegt jedes Gelenk links und rechts auf
// derselben Zeile. Der verbleibende Zeilenversatz misst, wie gut Kalibrierung und Gelenkerkennung
// zusammenpassen; daraus folgt eine Schaetzung, wie genau die Tiefe wirklich ist.
//
// Das Umrechnen der Bilder laeuft als WebGL-Shader: pro Bildpunkt der rektifizierten Ansicht
// Sehstrahl drehen, in die echte Kamera projizieren, Verzeichnung anwenden, Farbe holen.
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { CALIB_JOINTS, inFrame, MIN_VISIBILITY } from '../core/measure';
import { baselineFor, type Precision, type Rectification, rectifyPoint, triangulationPrecision } from '../core/rectify';
import { type StereoPose, triangulate } from '../core/stereo';
import { type Mat3, median, type Vec2 } from '../core/vec';
import type { CamId, CameraSetup } from './cameras';

const WINDOW = 150; // so viele Zeilenversaetze fliessen in die Schaetzung ein (einige Sekunden)
const TARGET_SIGMA = 0.02; // Ziel fuer die Empfehlung: 2 cm Tiefengenauigkeit
const LINES = 14; // Epipolarlinien pro Bild

export interface RectifiedStats {
  /** Zeilenversatz gleicher Gelenke, Median in Pixeln von Kamera A */
  rowOffsetPx: number;
  /** daraus geschaetzte Streuung eines Bildpunkts (normierte Koordinaten) */
  sigma: number;
  /** Genauigkeit an der Huefte, null wenn die Huefte nicht in beiden Bildern ist */
  hip: (Precision & { distance: number; baselineFor2cm: number }) | null;
  samples: number;
}

const VERT = `#version 300 es
in vec2 pos;
out vec2 tex;
void main() {
  tex = vec2(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5); // 0..1, y nach unten wie im Bild
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 tex;
out vec4 color;
uniform sampler2D video;
uniform mat3 rectToCam;   // Drehung rektifiziert -> Kamera
uniform float fr;         // Brennweite der Ansicht in Bildhoehen
uniform float outAspect;
uniform vec4 k;           // fx, fy, cx, cy (fx in Bildbreiten, fy in Bildhoehen)
uniform float dist[5];    // k1, k2, p1, p2, k3
void main() {
  vec3 r = vec3((tex.x - 0.5) * outAspect / fr, (tex.y - 0.5) / fr, 1.0);
  vec3 n = rectToCam * r;
  if (n.z <= 1e-6) { color = vec4(0.05, 0.05, 0.07, 1.0); return; }
  vec2 p = n.xy / n.z;
  float r2 = dot(p, p);
  float radial = 1.0 + r2 * (dist[0] + r2 * (dist[1] + r2 * dist[4]));
  vec2 d = p * radial + vec2(2.0 * dist[2] * p.x * p.y + dist[3] * (r2 + 2.0 * p.x * p.x),
                            dist[2] * (r2 + 2.0 * p.y * p.y) + 2.0 * dist[3] * p.x * p.y);
  vec2 uv = vec2(k.z + k.x * d.x, k.w + k.y * d.y);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { color = vec4(0.05, 0.05, 0.07, 1.0); return; }
  color = texture(video, uv);
}`;

/** Spaltenweise fuer WebGL: Transponierte von Rrect (Kamera -> rektifiziert) = rektifiziert -> Kamera, zeilenweise. */
const rectToCamColumnMajor = (R: Mat3): Float32Array => new Float32Array(R);

export class RectifiedView {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly textures: Record<CamId, WebGLTexture>;
  private readonly ctx: CanvasRenderingContext2D;
  private rect: Rectification | null = null;
  private pose: StereoPose | null = null;
  private readonly offsets: number[] = [];

  constructor(
    private readonly glCanvas: HTMLCanvasElement,
    private readonly overlay: HTMLCanvasElement,
    private readonly videos: Record<CamId, HTMLVideoElement>,
    private readonly cameras: CameraSetup,
  ) {
    const gl = glCanvas.getContext('webgl2');
    if (!gl) throw new Error('WebGL2 nicht verfügbar');
    this.gl = gl;
    this.program = link(gl, VERT, FRAG);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.program, 'pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const texture = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return t;
    };
    this.textures = { A: texture(), B: texture() };
    this.ctx = overlay.getContext('2d')!;
  }

  set(rect: Rectification | null, pose: StereoPose | null): void {
    this.rect = rect;
    this.pose = pose;
    this.offsets.length = 0;
  }

  /** Brennweite der Ansicht: etwas kleiner als die der Kameras, damit die gedrehten Bilder Platz haben. */
  private get fr(): number {
    return Math.min(this.cameras.focal('A'), this.cameras.focal('B')) * 0.75;
  }

  /** Beide Bilder umrechnen und die Gelenke einzeichnen. Liefert die laufende Schaetzung. */
  draw(imgA: NormalizedLandmark[] | null, imgB: NormalizedLandmark[] | null): RectifiedStats | null {
    const { rect, pose, gl } = this;
    if (!rect || !pose) return null;
    const vA = this.videos.A,
      vB = this.videos.B;
    if (vA.readyState < 2 || vB.readyState < 2) return null;

    const aspect = this.cameras.aspect('A');
    const h = 300,
      w = Math.round(h * aspect);
    for (const c of [this.glCanvas, this.overlay]) {
      if (c.width !== 2 * w || c.height !== h) {
        c.width = 2 * w;
        c.height = h;
      }
    }
    gl.useProgram(this.program);
    const u = (name: string) => gl.getUniformLocation(this.program, name);
    gl.uniform1f(u('fr'), this.fr);
    gl.uniform1f(u('outAspect'), aspect);
    (['A', 'B'] as CamId[]).forEach((cam, i) => {
      gl.viewport(i * w, 0, w, h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[cam]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.videos[cam]);
      gl.uniform1i(u('video'), 0);
      // Rrect ist zeilenweise Kamera -> rektifiziert; als Spaltenmatrix gelesen ergibt das die Umkehrung.
      gl.uniformMatrix3fv(u('rectToCam'), false, rectToCamColumnMajor(cam === 'A' ? rect.RA : rect.RB));
      const k = this.cameras.intrinsics[cam];
      const f = this.cameras.focal(cam),
        asp = this.cameras.aspect(cam);
      gl.uniform4f(u('k'), k ? k.fx : f / asp, k ? k.fy : f, k ? k.cx : 0.5, k ? k.cy : 0.5);
      gl.uniform1fv(u('dist[0]'), new Float32Array(k?.dist ?? [0, 0, 0, 0, 0]));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    });

    return this.drawJoints(imgA, imgB, w, h, aspect);
  }

  private drawJoints(imgA: NormalizedLandmark[] | null, imgB: NormalizedLandmark[] | null, w: number, h: number, aspect: number): RectifiedStats {
    const { ctx, rect, pose } = this;
    const fr = this.fr;
    ctx.clearRect(0, 0, 2 * w, h);
    ctx.strokeStyle = '#ffffff30';
    ctx.lineWidth = 1;
    for (let i = 1; i < LINES; i++) {
      const y = Math.round((i * h) / LINES) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(2 * w, y);
      ctx.stroke();
    }
    ctx.fillStyle = '#ffffff20';
    ctx.fillRect(w, 0, 1, h);

    const toPx = (r: Vec2, half: number): Vec2 => [half * w + ((r[0] * fr) / aspect + 0.5) * w, (r[1] * fr + 0.5) * h];
    const seen = (img: NormalizedLandmark[] | null, i: number) => {
      const p = img?.[i];
      return !!p && inFrame(p) && (p.visibility ?? 1) >= MIN_VISIBILITY;
    };
    const pxA = this.cameras.focal('A') * (this.videos.A.videoHeight || 720);
    const n = (cam: CamId, img: NormalizedLandmark[], i: number) => this.cameras.normalize(cam, img[i]!);

    CALIB_JOINTS.forEach((i, j) => {
      if (!imgA || !imgB || !seen(imgA, i) || !seen(imgB, i)) return;
      const a = rectifyPoint(n('A', imgA, i), rect!.RA);
      const b = rectifyPoint(n('B', imgB, i), rect!.RB);
      if (!a || !b) return;
      this.offsets.push(Math.abs(a[1] - b[1]));
      const pa = toPx(a, 0),
        pb = toPx(b, 1);
      const hue = (j * 360) / CALIB_JOINTS.length;
      ctx.strokeStyle = `hsla(${hue}, 85%, 65%, 0.55)`;
      ctx.beginPath();
      ctx.moveTo(pa[0], pa[1]);
      ctx.lineTo(pb[0], pb[1]);
      ctx.stroke();
      ctx.fillStyle = `hsl(${hue}, 85%, 65%)`;
      for (const p of [pa, pb]) {
        ctx.beginPath();
        ctx.arc(p[0], p[1], 3.5, 0, 2 * Math.PI);
        ctx.fill();
      }
    });
    if (this.offsets.length > WINDOW) this.offsets.splice(0, this.offsets.length - WINDOW);

    // Median des Betrags einer Normalverteilung = 0.674 sigma. Der Versatz ist die Differenz zweier
    // Bildpunkte, also sqrt(2)-mal so stark gestreut wie ein einzelner Punkt.
    const med = median(this.offsets);
    const sigma = med / 0.674 / Math.SQRT2;
    let hip: RectifiedStats['hip'] = null;
    if (imgA && imgB && [23, 24].every((i) => seen(imgA, i) && seen(imgB, i))) {
      const mid = (cam: CamId, img: NormalizedLandmark[]): Vec2 => {
        const l = n(cam, img, 23),
          r = n(cam, img, 24);
        return [(l[0] + r[0]) / 2, (l[1] + r[1]) / 2];
      };
      const X = triangulate(mid('A', imgA), mid('B', imgB), pose!.R, pose!.T);
      const p = X && sigma > 0 ? triangulationPrecision(X, pose!, sigma) : null;
      if (X && p) {
        const distance = Math.hypot(...X);
        hip = { ...p, distance, baselineFor2cm: baselineFor(distance, TARGET_SIGMA, Math.SQRT2 * sigma) };
      }
    }
    return { rowOffsetPx: med * pxA, sigma, hip, samples: this.offsets.length };
  }
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'Shader-Fehler');
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, shader(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'Link-Fehler');
  return p;
}
