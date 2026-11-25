// Schickt pro Bild, was der Avatar bekommt, ueber einen WebSocket an den Server (/ws/send); Buehne
// und Regie bauen daraus denselben Avatar nach. Nur Punkte, kein Bild, im Binaerformat aus
// protocol.ts: 110 bis 360 Bytes pro Bild. Kommt das Netz nicht nach, wird ein Bild ausgelassen statt
// gestaut, damit die Verzoegerung nicht waechst. Name und Lauf (contracts/stage-meta) gehen nur bei
// Aenderung mit.
import type { StageMeta } from '../contracts';
import { encodeFrame, type FrameInput, type Slot } from './protocol';
import { wsUrl } from './receiver';

/** Mehr ungesendete Bytes als das: das Netz kommt nicht nach, dieses Bild auslassen. */
const BACKLOG = 2048;

export interface LiveInfo {
  lan: boolean;
  /** Adressen der Buehne fuer Geraete im WLAN, leer ohne --lan */
  urls: string[];
  viewers: number;
  /** darf senden (dieser Rechner oder eingeloggt) */
  presenter: boolean;
  /** Platz des eingeloggten Presenters, null = frei waehlbar (dieser Rechner) */
  slot: Slot | null;
  /** nur auf diesem Rechner: Adresse fuer den Presenter-Login zum Testen */
  presenterUrl?: string;
}

export const fetchLiveInfo = async (): Promise<LiveInfo> => (await fetch('/api/info')).json() as Promise<LiveInfo>;

export class LiveSender {
  private socket: WebSocket | null = null;
  private meta = '';
  private slot: Slot = 'A';
  private wanted = false;
  /** ausgelassene Bilder seit dem Start */
  skipped = 0;

  /** status: Text fuer die Seite, z. B. «3 verbunden» oder «verbinde …». */
  constructor(private readonly status: (text: string) => void) {}

  start(slot: Slot): void {
    this.wanted = true;
    this.slot = slot;
    this.skipped = 0;
    this.connect();
  }

  stop(): void {
    this.wanted = false;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  /** Anderer Platz: neu verbinden (eingeloggte Presenter haben ihren Platz fest, der Server entscheidet). */
  setSlot(slot: Slot): void {
    this.slot = slot;
    if (this.wanted) {
      this.stop();
      this.start(slot);
    }
  }

  send(frame: FrameInput, meta: StageMeta): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > BACKLOG) {
      this.skipped++;
      return;
    }
    const text = JSON.stringify(meta);
    if (text !== this.meta) {
      socket.send(text);
      this.meta = text;
    }
    socket.send(encodeFrame(frame));
  }

  private connect(): void {
    if (!this.wanted || (this.socket && this.socket.readyState <= WebSocket.OPEN)) return;
    const socket = new WebSocket(wsUrl(`/ws/send?slot=${this.slot}`));
    this.socket = socket;
    this.meta = '';
    this.status('verbinde …');
    socket.onmessage = (e: MessageEvent<string>) => {
      const msg = JSON.parse(e.data) as { type: string; viewers?: number };
      if (msg.type === 'info') this.status(`${msg.viewers} verbunden` + (this.skipped ? ` · ${this.skipped} Bilder ausgelassen` : ''));
    };
    socket.onclose = (e) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.wanted) return;
      this.status(e.code === 1008 ? 'nicht eingeloggt: über present.<Adresse> anmelden' : 'Verbindung weg, verbinde neu …');
      setTimeout(() => this.connect(), e.code === 1008 ? 5000 : 1000);
    };
  }
}
