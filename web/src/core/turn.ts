// Drehwinkel einer Person aus der Schulterlinie mitzaehlen (gefuehrte Aufnahme).
import { LM, type Landmark } from './landmarks';

/** Winkel auf -180..180 Grad. */
export const wrapDegrees = (deg: number): number => ((deg + 540) % 360) - 180;

/** Blickrichtung aus der Schulterlinie in 3D (Weltpunkte): 0 Grad = schaut in die Kamera. */
export function shoulderYaw(world: Landmark[]): number {
  const dx = world[LM.lSh].x - world[LM.rSh].x,
    dz = world[LM.lSh].z - world[LM.rSh].z;
  return (Math.atan2(dz, dx) * 180) / Math.PI;
}

/** Zaehlt den gedrehten Winkel und die Drehgeschwindigkeit aus aufeinanderfolgenden Blickrichtungen. */
export class TurnCounter {
  /** gedrehter Winkel in Grad, Vorzeichen = Drehrichtung */
  turned = 0;
  /** geglaettete Drehgeschwindigkeit in Grad pro Sekunde */
  speed = 0;
  private prevYaw: number | null;
  private prevT: number;

  constructor(yaw: number | null, now: number) {
    this.prevYaw = yaw;
    this.prevT = now;
  }

  /** Anteil einer ganzen Umdrehung (0..1 und mehr). */
  get fraction(): number {
    return Math.abs(this.turned) / 360;
  }

  update(yaw: number | null, now: number): void {
    if (yaw !== null && this.prevYaw !== null && now > this.prevT) {
      const d = wrapDegrees(yaw - this.prevYaw);
      // Spruenge um fast 180 Grad sind vertauschte Schultern, keine echte Drehung.
      if (Math.abs(d) < 60) {
        this.turned += d;
        this.speed += (Math.abs(d) / ((now - this.prevT) / 1000) - this.speed) * 0.05;
      }
    }
    if (yaw !== null) {
      this.prevYaw = yaw;
      this.prevT = now;
    }
  }
}
