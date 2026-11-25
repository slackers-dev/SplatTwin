// Sprachansage: die Person steht weit weg und sieht den Bildschirm nicht immer.

export class Speaker {
  private last = { text: '', at: 0 };

  /** Sagt text; dieselbe Ansage hoechstens alle minGap Sekunden. */
  say(text: string, minGap = 0): void {
    const now = performance.now();
    if (text === this.last.text && now - this.last.at < minGap * 1000) return;
    this.last = { text, at: now };
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'de-DE';
      speechSynthesis.speak(u);
    } catch {
      /* Ansage ist nur Komfort */
    }
  }
}
