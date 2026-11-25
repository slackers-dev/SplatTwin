// Schachbrett-Kalibrierung einer Kamera: Vollbild mit Schachbrett, Einzelbilder an den Server,
// Abdeckung des Bildes als kleine Karte. Ergebnis sind Kameramatrix und Verzeichnung.
import type { Intrinsics } from '../../contracts';
import { calibrateCamera, postChessboard } from '../../tracking/calibration-api';
import type { CamId } from '../../tracking/cameras';
import { byId } from '../../ui/dom';

const VIEWS = 20;
const INTERVAL_MS = 600;

interface Run {
  cam: CamId;
  timer: number;
  busy: boolean;
  first: boolean;
  canvas: HTMLCanvasElement;
}

export class ChessboardCalibration {
  private run: Run | null = null;
  private readonly overlay = byId('chess');
  private readonly info = byId('chessInfo');
  private readonly view = byId<HTMLVideoElement>('chessVideo');
  private readonly coverage = byId<HTMLCanvasElement>('coverage');

  constructor(
    private readonly videoOf: (cam: CamId) => HTMLVideoElement,
    private readonly onDone: (cam: CamId, k: Intrinsics) => void,
    private readonly onMessage: (text: string) => void,
  ) {
    byId('board').replaceChildren(
      ...Array.from({ length: 70 }, (_, i) => {
        const cell = document.createElement('i');
        if ((Math.floor(i / 10) + i) % 2) cell.className = 'w';
        return cell;
      }),
    );
    byId('btnChessCancel').addEventListener('click', () => this.stop('Kalibrierung abgebrochen.'));
  }

  start(cam: CamId): void {
    const video = this.videoOf(cam);
    if (video.readyState < 2) {
      this.onMessage(`Zuerst Kamera ${cam} starten.`);
      return;
    }
    // Kamera B filmt das Brett auf diesem Bildschirm. Kamera A sieht den eigenen
    // Bildschirm nicht: dort das Brett auf dem Handy zeigen und im Livebild kontrollieren.
    byId('board').hidden = cam === 'A';
    const view = this.view;
    view.hidden = false;
    view.classList.toggle('mini', cam === 'B'); // bei B nur als kleine Kontrollansicht in der Ecke
    if (video.srcObject) view.srcObject = video.srcObject;
    else view.src = video.currentSrc;
    void view.play();
    this.info.textContent =
      cam === 'A'
        ? 'Kamera A: Schachbrett (/schachbrett.png) auf dem Handy anzeigen und vor die Kamera halten.'
        : 'Kamera B: Mit dem iPhone dieses Schachbrett filmen. Unten rechts siehst du, was das iPhone sieht.';
    this.coverage.getContext('2d')!.clearRect(0, 0, 352, 198);
    this.overlay.hidden = false;
    this.run = { cam, busy: false, first: true, canvas: document.createElement('canvas'), timer: window.setInterval(() => void this.tick(), INTERVAL_MS) };
  }

  stop(message?: string): void {
    if (!this.run) return;
    clearInterval(this.run.timer);
    this.run = null;
    this.overlay.hidden = true;
    this.view.srcObject = null;
    this.view.removeAttribute('src');
    if (message) this.onMessage(message);
  }

  private async tick(): Promise<void> {
    const run = this.run;
    if (!run || run.busy) return;
    run.busy = true;
    try {
      const video = this.videoOf(run.cam);
      run.canvas.width = video.videoWidth;
      run.canvas.height = video.videoHeight;
      run.canvas.getContext('2d')!.drawImage(video, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) =>
        run.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Bild nicht lesbar'))), 'image/jpeg', 0.92),
      );
      const d = await postChessboard(run.cam, blob, run.first);
      run.first = false;
      if (this.run !== run) return;
      if (d.corners) {
        const ctx = this.coverage.getContext('2d')!;
        ctx.fillStyle = '#2a9d6f';
        for (const [x, y] of d.corners) ctx.fillRect(x * 352 - 1.5, y * 198 - 1.5, 3, 3);
      }
      const hint = !d.found ? 'Brett nicht erkannt' : d.accepted ? 'übernommen' : 'erkannt, bitte weiterbewegen';
      this.info.textContent =
        `Kamera ${run.cam}: ${d.count} / ${VIEWS} Ansichten · ${hint}. ` +
        'Brett aus verschiedenen Winkeln und Abständen zeigen, auch am Bildrand und in den Ecken (kleines Feld unten links).';
      if (d.count >= VIEWS) {
        clearInterval(run.timer);
        this.info.textContent = 'Rechne …';
        const k = await calibrateCamera(run.cam);
        this.stop();
        this.onDone(run.cam, k);
      }
    } catch (err) {
      this.stop('Kalibrierung abgebrochen: ' + (err as Error).message);
    } finally {
      run.busy = false;
    }
  }
}
