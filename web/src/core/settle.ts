// Bezugspunkt erst festlegen, wenn die Messung ruhig ist.
//
// Die ersten Bilder einer Person, die ins Bild laeuft, sind oft nur halb erkannt und liegen weit daneben
// (Entfernung 15 m statt 3 m). Wer dort den Nullpunkt setzt, schiebt den Avatar fuer immer weg, z. B.
// hinter die Kamera. Settle liefert erst einen Punkt, wenn die letzten `frames` Messungen in jeder Achse
// hoechstens `spread` auseinanderliegen, und dann deren Mittel.
import type { Vec3 } from './vec';

export class Settle {
  private recent: Vec3[] = [];

  constructor(
    private readonly frames = 8,
    private readonly spread = 0.15,
  ) {}

  reset(): void {
    this.recent = [];
  }

  /** Neue Messung; liefert den Bezugspunkt, sobald die Messung ruhig ist, sonst null. */
  step(p: Vec3 | null): Vec3 | null {
    if (!p) return null;
    this.recent.push(p);
    if (this.recent.length > this.frames) this.recent.shift();
    if (this.recent.length < this.frames) return null;
    const mean: Vec3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const v = this.recent.map((q) => q[k]!);
      if (Math.max(...v) - Math.min(...v) > this.spread) return null;
      mean[k] = v.reduce((a, b) => a + b, 0) / v.length;
    }
    return mean;
  }
}
