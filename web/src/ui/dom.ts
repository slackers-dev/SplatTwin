// Kleine Helfer fuer die Seiten.

/** Element mit dieser id; wirft, wenn es fehlt (Tippfehler fallen sofort auf). */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element #${id} fehlt`);
  return el as T;
}

export const params = (): URLSearchParams => new URLSearchParams(location.search);

/** Zahl aus der Adresse, sonst fallback. */
export function numberParam(key: string, fallback: number): number {
  const v = params().get(key);
  return v ? +v : fallback;
}
