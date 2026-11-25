// Gefuehrte Aufnahme: warten, bis die Person richtig steht, dann die Drehung mitzaehlen.
import { TurnCounter } from '../core/turn';
import type { PersonState } from './analyse';

export interface FlowUI {
  phase(text: string, recording?: boolean): void;
  /** Fortschritt 0..1 */
  progress(f: number): void;
  say(text: string, minGap?: number): void;
}

const frame = () => new Promise<number>((r) => requestAnimationFrame(r));

/**
 * Wartet, bis cond() "hold" Sekunden lang ununterbrochen gilt. Liefert den Zeitpunkt,
 * an dem diese Strecke begann, oder null nach "timeout" Sekunden.
 */
export async function waitFor(cond: () => boolean, hold: number, timeout: number, ui: FlowUI, onWait?: () => void): Promise<number | null> {
  const t0 = performance.now();
  let since: number | null = null;
  for (;;) {
    const now = performance.now();
    if (cond()) since ??= now;
    else since = null;
    ui.progress(since === null ? 0 : (now - since) / 1000 / hold);
    if (since !== null && now - since >= hold * 1000) return since;
    if (now - t0 > timeout * 1000) return null;
    onWait?.();
    await frame();
  }
}

/** Wartet, bis die Person richtig steht (je nach Modus), zur Kamera schaut und stillhaelt. */
export async function pose(label: string, notes: string[], A: () => PersonState, ui: FlowUI, hold: number, timeout: number): Promise<void> {
  let ref: [number, number] | null = null;
  const still = () => {
    const c = A().center;
    if (!c) return false;
    if (!ref || Math.hypot(c[0] - ref[0], c[1] - ref[1]) > 0.03) {
      ref = c;
      return false;
    }
    return true;
  };
  const problem = () => {
    const a = A();
    if (!a.present) return 'Ich sehe dich noch nicht';
    if (a.hint) return a.hint;
    if (Math.abs(a.yaw ?? 0) > 25) return 'Dreh dich zur Kamera';
    return '';
  };
  const ok = await waitFor(() => !problem() && still(), hold, timeout, ui, () => {
    const p = problem();
    ui.phase(p || 'Gut so – kurz stillhalten', true);
    if (p) ui.say(p, 6);
  });
  if (ok === null) notes.push(`${label}: Pose nicht bestaetigt (${problem() || 'nicht still'}), Drehung trotzdem gestartet.`);
}

/** Zaehlt den Drehwinkel aus der Schulterlinie mit, bis 360 Grad voll sind. Liefert die Gradzahl. */
export async function turn(label: string, notes: string[], A: () => PersonState, ui: FlowUI, turnSeconds: number): Promise<number> {
  ui.say('Jetzt zügig und gleichmässig drehen, Arme ruhig.');
  const calls: [number, string][] = [[0.25, 'Viertel'], [0.5, 'Halb'], [0.75, 'Drei Viertel']];
  const t0 = performance.now();
  const counter = new TurnCounter(A().yaw, t0);
  for (;;) {
    await frame();
    const now = performance.now(),
      elapsed = (now - t0) / 1000;
    counter.update(A().yaw, now);
    const f = counter.fraction;
    ui.progress(f);
    ui.phase(`${label}: gleichmässig drehen – ${Math.round(Math.abs(counter.turned))}°`, true);
    while (calls.length && f >= calls[0]![0]) ui.say(calls.shift()![1]);
    if (counter.speed > (360 / turnSeconds) * 1.8 && elapsed > 2) ui.say('Langsamer', 5);
    // Zu langsam schadet mehr als zu schnell: je laenger die Drehung, desto mehr bewegt sich der Koerper.
    else if (counter.speed < (360 / turnSeconds) * 0.6 && elapsed > 4) ui.say('Schneller', 6);
    if (f >= 0.985) {
      if (elapsed > turnSeconds * 1.5)
        notes.push(`${label}: Drehung zu langsam (${Math.round(elapsed)} s statt etwa ${turnSeconds} s), der Splat wird unscharf.`);
      break;
    }
    if (elapsed > turnSeconds * 2 || (elapsed > turnSeconds * 1.2 && f < 0.5)) {
      notes.push(`${label}: Drehwinkel unsicher (${Math.round(Math.abs(counter.turned))} Grad gezaehlt), nach Zeit beendet.`);
      break;
    }
  }
  return Math.round(counter.turned);
}
