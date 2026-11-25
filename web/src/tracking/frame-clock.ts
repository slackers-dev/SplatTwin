// Aufnahmezeitpunkt des gerade gezeigten Bildes je Kamera, damit der Filter die Bilder zeitlich
// richtig einordnen kann (die Kameras laufen nicht synchron).
import { appStream } from './app-bridge';

export class FrameClock {
  private time: number | null = null;

  constructor(video: HTMLVideoElement) {
    if (!video.requestVideoFrameCallback) return;
    const onFrame: VideoFrameRequestCallback = (now, meta) => {
      // Kameras der Splattwin-App kennen die echte Aufnahmezeit am Geraet.
      this.time = appStream(video.srcObject)?.timeOf(meta, now) ?? meta.captureTime ?? meta.expectedDisplayTime ?? now;
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }

  stamp(now: number): number {
    return this.time ?? now;
  }
}
