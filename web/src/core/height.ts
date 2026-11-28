// Hoehe der Huefte relativ zum aufrechten Stehen: negativ in der Hocke, positiv im Sprung.
//
// Die Kamera misst die Hoehe nur relativ zu ihrer Bildmitte, und niemand weiss, wo sie steht. Bezug
// ist deshalb das Stehen beim Start:
// - Erst wenn die Messung eine Weile ruhig ist (SETTLE_FRAMES Bilder innerhalb von SETTLE_SPREAD), gilt sie
//   als Bezug. Die ersten Bilder einer Person, die ins Bild kommt, sind oft nur halb und liegen weit daneben.
// - Liegt die Huefte laenger als RAISE_SECONDS deutlich ueber dem Bezug, ist das das neue Stehen (die
//   Person kam gebueckt ins Bild oder sass beim Start). Ein Sprung ist kuerzer und bleibt ein Sprung.
// - Ist die Person laenger als LOST_SECONDS weg, beginnt alles neu.
// Bis ein Bezug steht, ist die Hoehe unbekannt (null).

const RAISE_ABOVE = 0.04; // m ueber dem Bezug, ab dann zaehlt die Zeit
const RAISE_SECONDS = 1.2;
const SETTLE_FRAMES = 8;
const SETTLE_SPREAD = 0.06; // m
const LOST_SECONDS = 1;

export class StandingHeight {
  private ref: number | null = null;
  private above = 0;
  private lost = 0;
  private settle: number[] = [];

  reset(): void {
    this.ref = null;
    this.above = 0;
    this.lost = 0;
    this.settle = [];
  }

  /** y: Hoehe der Huefte (Achsen des Avatars, m), dt in s. Liefert die Hoehe relativ zum Stehen. */
  step(y: number | null, dt: number): number | null {
    if (y === null || !Number.isFinite(y)) {
      this.lost += dt;
      if (this.lost > LOST_SECONDS) this.reset();
      return null;
    }
    this.lost = 0;
    if (this.ref === null) {
      this.settle.push(y);
      if (this.settle.length > SETTLE_FRAMES) this.settle.shift();
      if (this.settle.length < SETTLE_FRAMES || Math.max(...this.settle) - Math.min(...this.settle) > SETTLE_SPREAD) return null;
      this.ref = this.settle.reduce((a, b) => a + b, 0) / SETTLE_FRAMES;
    }
    if (y - this.ref > RAISE_ABOVE) {
      this.above += dt;
      if (this.above > RAISE_SECONDS) {
        this.ref = y;
        this.above = 0;
      }
    } else this.above = 0;
    return y - this.ref;
  }
}
