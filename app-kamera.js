// Kameras der Splattwin-App im Browser.
//
// Die Mac-App (projekt/app) oeffnet auf diesem Rechner eine Bruecke (ws://127.0.0.1:8932). Dieses
// Modul haengt ihre Kameras in die normale Kameraliste des Browsers ein: sie erscheinen als
// «Splattwin: …» und lassen sich mit getUserMedia oeffnen wie jede Webcam. Zusaetzlich bringt
// jeder solche Stream mit, was der Browser sonst nicht weiss (stream.splattwin):
//   timeOf(meta, now)  Aufnahmezeit des gezeigten Bildes auf der Zeitachse von performance.now() (T-7)
//   intrinsics         Kameradaten des Geraets im Format von main.js, oder null (T-3, T-4)
//   onchange           wird gerufen, wenn sich Linse, Format oder Kameradaten aendern (T-5)
// window.splattwin.baseline ist der in der App eingetragene Kameraabstand in Metern (T-9).
//
// Laeuft die App nicht, passiert nichts: die Seite arbeitet wie bisher.

const BRIDGE = 'ws://127.0.0.1:8932/';
const PREFIX = 'splattwin:';
const media = navigator.mediaDevices;

const state = {
  socket: null,
  cameras: [],          // Liste der App, zuletzt gemeldet
  streams: new Map(),   // Kamera -> Menge offener Streams
  clock: null,          // Mac-Uhr minus performance.now(), in ms
  bestTrip: Infinity,
};
window.splattwin = { baseline: null, get cameras() { return state.cameras; }, get connected() { return !!state.socket; } };

const info = (id) => state.cameras.find((c) => c.id === id);

// Kameradaten so, wie main.js sie nach einer Schachbrett-Kalibrierung ablegt.
function intrinsicsOf(cam) {
  if (!cam?.k) return null;
  const [fx, fy, cx, cy] = cam.k;
  const deg = (f) => (2 * Math.atan(0.5 / f) * 180) / Math.PI;
  return { fx, fy, cx, cy, dist: [0, 0, 0, 0, 0], rms: 0, views: 0, fovX: deg(fx), fovY: deg(fy),
    width: cam.width, height: cam.height, source: cam.source, distortion: cam.distortion };
}

// Hat sich etwas geaendert, das eine Kalibrierung ungueltig macht? Kleine Schwankungen
// (der Bildstabilisator verschiebt den Bildmittelpunkt um Bruchteile eines Pixels) zaehlen nicht.
function differs(a, b) {
  if (!a || !b) return a !== b;
  if (a.lens !== b.lens || a.width !== b.width || a.height !== b.height || a.distortion !== b.distortion) return true;
  if (!a.k || !b.k) return !!a.k !== !!b.k;
  return Math.abs(a.k[0] / b.k[0] - 1) > 0.02 || Math.abs(a.k[2] - b.k[2]) > 0.02 || Math.abs(a.k[3] - b.k[3]) > 0.02;
}

function send(message) {
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(message));
}

function onList(message) {
  const before = state.cameras;
  state.cameras = message.cameras ?? [];
  window.splattwin.baseline = message.baseline ?? null;
  for (const [id, entries] of state.streams) {
    const now = info(id), old = before.find((c) => c.id === id);
    if (!differs(now, old)) continue;
    for (const entry of entries) {
      entry.info = now ?? entry.info;
      try { entry.stream.splattwin.onchange?.(); } catch (err) { console.error(err); }
    }
  }
  const ids = (list) => list.map((c) => c.id + c.lens).sort().join('|');
  if (ids(before) !== ids(state.cameras)) media.dispatchEvent(new Event('devicechange'));
}

async function onFrame(buffer) {
  const count = new DataView(buffer).getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, count)));
  const entries = state.streams.get(head.id);
  if (!entries?.size) return;
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(buffer, 4 + count)], { type: 'image/jpeg' }));
  const drawnAt = performance.now();
  for (const entry of entries) {
    if (head.seq <= entry.seq) continue; // ein aelteres Bild wurde spaeter fertig dekodiert
    entry.seq = head.seq;
    const { canvas } = entry;
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    entry.context.drawImage(bitmap, 0, 0);
    // Wann wurde welches Bild auf die Zeichenflaeche gelegt? Damit findet timeOf() die Aufnahmezeit.
    entry.drawn.push({ at: drawnAt, hub: head.t });
    if (entry.drawn.length > 12) entry.drawn.shift();
  }
  bitmap.close();
}

function openStream(id) {
  const cam = info(id);
  if (!cam) return Promise.reject(new DOMException('Diese Kamera der Splattwin-App ist nicht mehr verbunden.', 'NotFoundError'));
  const canvas = document.createElement('canvas');
  canvas.width = cam.width || 1280;
  canvas.height = cam.height || 720;
  const context = canvas.getContext('2d');
  context.fillRect(0, 0, canvas.width, canvas.height);
  const stream = canvas.captureStream();
  const entry = { id, canvas, context, stream, info: cam, drawn: [], seq: 0 };
  const [track] = stream.getVideoTracks();

  const settings = track.getSettings.bind(track);
  track.getSettings = () => ({ ...settings(), deviceId: PREFIX + id, width: canvas.width, height: canvas.height, frameRate: entry.info.fps });
  const stop = track.stop.bind(track);
  track.stop = () => {
    stop();
    const entries = state.streams.get(id);
    entries?.delete(entry);
    if (entries && !entries.size) {
      state.streams.delete(id);
      send({ type: 'unsubscribe', id });
    }
  };

  stream.splattwin = {
    id,
    onchange: null,
    get info() { return entry.info; },
    get intrinsics() { return intrinsicsOf(entry.info); },
    // meta: zweites Argument von requestVideoFrameCallback. Das Videoelement zeigt, was zu diesem
    // Zeitpunkt auf der Zeichenflaeche lag; dessen Aufnahmezeit wird auf performance.now() umgerechnet.
    timeOf(meta, now = performance.now()) {
      if (state.clock === null || !entry.drawn.length) return undefined;
      const shown = meta?.captureTime ?? meta?.expectedDisplayTime ?? now;
      let match = entry.drawn[0];
      for (const d of entry.drawn) if (d.at <= shown + 1) match = d;
      return match.hub - state.clock;
    },
    get latency() {
      const last = entry.drawn.at(-1);
      return last && state.clock !== null ? last.at - (last.hub - state.clock) : null;
    },
  };

  if (!state.streams.has(id)) state.streams.set(id, new Set());
  state.streams.get(id).add(entry);
  send({ type: 'subscribe', id, maxFps: 60 });
  return Promise.resolve(stream);
}

// Uhrenabgleich mit dem Mac: die Messung mit der kuerzesten Laufzeit gilt.
function ping() {
  send({ type: 'ping', c: performance.now() });
}

function onPong(message) {
  const now = performance.now();
  const trip = now - message.c;
  state.bestTrip *= 1.02; // alte Messungen langsam vergessen
  if (trip <= state.bestTrip) {
    state.bestTrip = trip;
    state.clock = message.s - (message.c + now) / 2;
  }
}

function connect() {
  let socket;
  try { socket = new WebSocket(BRIDGE); } catch { return setTimeout(connect, 5000); }
  socket.binaryType = 'arraybuffer';
  socket.onopen = () => {
    state.socket = socket;
    state.bestTrip = Infinity;
    ping();
    for (const id of state.streams.keys()) send({ type: 'subscribe', id, maxFps: 60 });
  };
  socket.onmessage = (event) => {
    if (typeof event.data !== 'string') return onFrame(event.data).catch(() => {});
    const message = JSON.parse(event.data);
    if (message.type === 'cameras') onList(message);
    else if (message.type === 'pong') onPong(message);
  };
  socket.onclose = () => {
    if (state.socket === socket) {
      state.socket = null;
      if (state.cameras.length) onList({ cameras: [] });
    }
    setTimeout(connect, 5000);
  };
}

if (media?.getUserMedia) {
  const enumerate = media.enumerateDevices.bind(media);
  media.enumerateDevices = async () => [
    ...(await enumerate()),
    ...state.cameras.map((c) => ({
      deviceId: PREFIX + c.id, groupId: 'splattwin', kind: 'videoinput',
      label: `Splattwin: ${c.name}${c.lens ? ` (${c.lens})` : ''}`,
      toJSON() { return { deviceId: this.deviceId, groupId: this.groupId, kind: this.kind, label: this.label }; },
    })),
  ];
  const getUserMedia = media.getUserMedia.bind(media);
  media.getUserMedia = (constraints) => {
    const wanted = constraints?.video?.deviceId;
    const id = typeof wanted === 'string' ? wanted : wanted?.exact ?? wanted?.ideal;
    if (typeof id === 'string' && id.startsWith(PREFIX)) return openStream(id.slice(PREFIX.length));
    return getUserMedia(constraints);
  };
  setInterval(ping, 2000);
  connect();
}
