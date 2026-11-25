// Ein Presenter auf der Buehne: eigener Roboter (mit Splat, sobald geladen), Ring am Boden,
// Scheinwerfer und Namensschild. Bekommt die Live-Bilder seines Platzes und blendet zwischen ihnen
// ueber (core/blend), damit es auch bei wenigen Bildern pro Sekunde fluessig aussieht.
import * as THREE from 'three';
import type { LiveFrame, StageMeta } from '../contracts';
import { FrameBlend } from '../core/blend';
import type { Slot } from '../live/protocol';
import { toVectors } from './points';
import type { Retargeter } from './retarget';
import { cloneRobot } from './robot';
import { SEATS, seatPosition } from './room';
import { loadSplatAvatar, type SplatAvatar } from './splat-avatar';

const STALE_MS = 2000; // so lange ohne Bild gilt ein Presenter als offline
const ROAM = 1.4; // so weit (m) darf ein Presenter von seinem Platz weglaufen

// Splats nacheinander laden: auf schwachen Geraeten sonst zwei schwere Rechnungen gleichzeitig.
let splatQueue: Promise<void> = Promise.resolve();

export class Presenter {
  readonly retargeter: Retargeter;
  private readonly group = new THREE.Group();
  private readonly ring: THREE.Mesh;
  private readonly spot: THREE.SpotLight;
  private readonly label: Label;
  private readonly blend = new FrameBlend();
  private splat: SplatAvatar | null = null;
  private splatRun = '';
  private splatOn = true;
  private frames = 0;
  private rateStart = 0;
  name = '';
  run = '';
  online = false;
  /** ankommende Bilder pro Sekunde */
  rate = 0;
  /** gerade wird der Splat geladen */
  loading = false;

  constructor(
    readonly slot: Slot,
    private readonly scene: THREE.Scene,
    private readonly renderer: THREE.WebGLRenderer,
    template: THREE.Object3D,
  ) {
    const seat = SEATS[slot];
    this.group.position.copy(seatPosition(slot));
    scene.add(this.group);
    this.retargeter = cloneRobot(template, this.group);
    // Gelenke in der Farbe des Platzes
    this.retargeter.model.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m && /joint/i.test(m.name)) m.color.set(seat.color);
    });
    this.retargeter.model.visible = false;

    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 48), new THREE.MeshBasicMaterial({ color: seat.color, transparent: true, opacity: 0.35 }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.01;
    this.group.add(this.ring);

    this.spot = new THREE.SpotLight(0xffffff, 0, 12, 0.32, 0.6, 0);
    this.spot.color.set(seat.color).lerp(new THREE.Color(0xffffff), 0.7);
    this.spot.position.set(seat.x * 0.6, 6, 2.5);
    this.spot.target = this.ring;
    this.spot.castShadow = true;
    this.spot.shadow.mapSize.set(1024, 1024);
    scene.add(this.spot);

    this.label = new Label();
    this.label.sprite.position.y = 2.25;
    this.group.add(this.label.sprite);
  }

  /** Standort mitten auf seinem Ring (fuer die Kamera-Ansicht) */
  position(): THREE.Vector3 {
    const p = seatPosition(this.slot);
    if (this.online) p.add(new THREE.Vector3(this.retargeter.model.position.x, 0, this.retargeter.model.position.z));
    return p;
  }

  receive(frame: LiveFrame, now: number): void {
    this.blend.receive(frame, now);
    this.frames++;
  }

  /** Name und Lauf; der Splat wird sofort geladen, auch bevor der Presenter sendet. */
  setMeta(meta: StageMeta): void {
    this.name = meta.name;
    this.run = meta.run;
    if (this.splatOn) this.wantSplat(meta.run);
  }

  /** Splat statt Roboter (laedt ihn bei Bedarf), oder zurueck zum Roboter. */
  setSplatOn(on: boolean): void {
    this.splatOn = on;
    if (on) this.wantSplat(this.run);
    if (!this.splat) return;
    if (on) this.splat.setVisible(this.online);
    else this.splat.setView({ splat: false });
  }

  private wantSplat(run: string): void {
    if (!run || this.splatRun === run) return;
    this.splatRun = run;
    splatQueue = splatQueue.then(async () => {
      if (this.splatRun !== run) return; // inzwischen ein anderer Lauf gewuenscht
      this.splat?.dispose();
      this.splat = null;
      this.loading = true;
      try {
        this.splat = await loadSplatAvatar(this.scene, this.renderer, this.retargeter, run);
        this.splat.setVisible(this.splatOn && this.online);
      } catch (err) {
        console.warn(`Splat fuer Platz ${this.slot} nicht geladen, zeige den Roboter:`, err);
      }
      this.loading = false;
    });
  }

  update(now: number): void {
    const f = this.blend.sample(now); // null vor dem ersten Bild
    const online = !!f && now - this.blend.lastTime < STALE_MS;
    if (f && online) {
      const r = this.retargeter;
      r.upperBodyOnly = f.upper;
      r.apply(toVectors(f.pts) ?? [], { Left: toVectors(f.hands.Left), Right: toVectors(f.hands.Right) });
      const clamp = (v: number) => Math.max(-ROAM, Math.min(ROAM, v));
      r.model.position.x = clamp(f.pos[0]!);
      r.model.position.z = clamp(f.pos[1]!);
    }
    if (online !== this.online) {
      this.online = online;
      this.retargeter.model.visible = online;
      if (this.splat) this.splat.setVisible(this.splatOn && online);
    }
    if (now - this.rateStart > 1000) {
      this.rate = Math.round((this.frames * 1000) / (now - this.rateStart || 1));
      this.frames = 0;
      this.rateStart = now;
    }
    // Scheinwerfer weich ein- und ausblenden
    this.spot.intensity += ((online ? 2.2 : 0.35) - this.spot.intensity) * 0.08;
    const { x, z } = this.retargeter.model.position;
    this.ring.position.set(x, 0.01, z);
    this.label.sprite.position.set(x, 2.25, z);
    const title = this.name || `Platz ${this.slot}`;
    this.label.draw(online ? title : `${title} · wartet`, SEATS[this.slot].css, online);
  }
}

/** Namensschild ueber dem Kopf (Canvas als Sprite). */
class Label {
  readonly sprite: THREE.Sprite;
  private readonly canvas = document.createElement('canvas');
  private readonly texture: THREE.CanvasTexture;
  private key = '';

  constructor() {
    this.canvas.width = 512;
    this.canvas.height = 112;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.texture, depthWrite: false, transparent: true }));
    this.sprite.scale.set(1.1, 0.24, 1);
  }

  draw(text: string, color: string, online: boolean): void {
    const key = text + online;
    if (this.key === key) return;
    this.key = key;
    const g = this.canvas.getContext('2d')!;
    g.clearRect(0, 0, 512, 112);
    g.font = '600 46px system-ui, sans-serif';
    const w = Math.min(500, g.measureText(text).width + 90);
    const left = (512 - w) / 2;
    g.fillStyle = '#14161add';
    g.beginPath();
    g.roundRect(left, 14, w, 84, 42);
    g.fill();
    g.fillStyle = online ? color : '#5a5f69';
    g.beginPath();
    g.arc(left + 40, 56, 11, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = online ? '#e6e8ec' : '#9aa1ad';
    g.textBaseline = 'middle';
    g.fillText(text, left + 64, 58, w - 80);
    this.texture.needsUpdate = true;
  }
}
