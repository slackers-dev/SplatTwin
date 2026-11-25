// Presenter-Login: nur ueber eine Adresse, die mit present. beginnt (server/access.py). Danach geht es
// zur Tracking-Seite, gesendet wird immer auf dem Platz des Logins.
import './style.css';
import { byId } from '../../ui/dom';

const form = byId<HTMLFormElement>('form');
const msg = byId('msg');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = '';
  const slot = (form.elements.namedItem('slot') as RadioNodeList).value;
  const password = byId<HTMLInputElement>('pw').value;
  try {
    const r = await fetch('/api/login', { method: 'POST', body: JSON.stringify({ slot, password }) });
    const data = (await r.json()) as { error?: string };
    if (!r.ok) {
      msg.textContent = data.error ?? 'Login fehlgeschlagen';
      return;
    }
    location.href = '/tracking.html';
  } catch {
    msg.textContent = 'Server nicht erreichbar';
  }
});
