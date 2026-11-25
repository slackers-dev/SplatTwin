// Empfaengt alles fuer die Buehne ueber einen WebSocket (/ws/stage): Folienstand und Platz-Infos als
// Text (contracts/stage-slides, contracts/stage-meta), die Bilder der Presenter binaer mit dem Platz
// davor (protocol.ts). Verbindet nach einem Abbruch selbst neu.
import type { LiveFrame, StageMeta, StageSlides } from '../contracts';
import { decodeFrame, type Slot, SLOTS } from './protocol';

export const wsUrl = (path: string): string => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;

export interface StageHandlers {
  open?(): void;
  close?(): void;
  slides?(state: StageSlides): void;
  meta?(slot: Slot, meta: StageMeta): void;
  frame?(slot: Slot, frame: LiveFrame): void;
}

type TextMessage = { type: 'slides'; state: StageSlides } | { type: 'meta'; slot: Slot; meta: StageMeta };

/** Rueckgabe: Funktion zum Beenden. */
export function connectStage(handlers: StageHandlers): () => void {
  let delay = 500;
  let socket: WebSocket | null = null;
  let stopped = false;
  const open = () => {
    const s = new WebSocket(wsUrl('/ws/stage'));
    socket = s;
    s.binaryType = 'arraybuffer';
    s.onopen = () => {
      delay = 500;
      handlers.open?.();
    };
    s.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
      if (typeof e.data === 'string') {
        const msg = JSON.parse(e.data) as TextMessage;
        if (msg.type === 'slides') handlers.slides?.(msg.state);
        else if (msg.type === 'meta') handlers.meta?.(msg.slot, msg.meta);
        return;
      }
      const slot = SLOTS[new Uint8Array(e.data, 0, 1)[0]!];
      if (slot) handlers.frame?.(slot, decodeFrame(e.data, 1));
    };
    s.onclose = () => {
      handlers.close?.();
      if (stopped) return;
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 8000);
    };
  };
  open();
  return () => {
    stopped = true;
    socket?.close();
  };
}
