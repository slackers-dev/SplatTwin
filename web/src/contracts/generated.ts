// Erzeugt aus contracts/*.schema.json mit `npm run gen:contracts`. Nicht von Hand aendern.

/**
 * Metadatei einer Aufnahme: data/captures/<name>.json. Schreiben: capture.html und die Mac-App. Lesen: splattwin process. Alle Zeiten in Sekunden im Video der Kamera a.
 */
export interface Capture {
  name: string;
  /**
   * Zeitmarken der Phasen. bgStart/bgEnd: leerer Raum, turnStart/turnEnd: Körperdrehung, faceStart/faceEnd: Gesichtsscan.
   */
  marks: {
    bgStart?: number;
    bgEnd?: number;
    turnStart?: number;
    turnEnd?: number;
    turnedDegrees?: number;
    faceStart?: number;
    faceEnd?: number;
    faceDegrees?: number;
    [k: string]: number | undefined;
  };
  /**
   * So viel später liegt ein Ereignis in Video b als in Video a.
   */
  offset: number;
  /**
   * Gespeicherte Videos je Kamera (a, b).
   */
  saved: {
    [k: string]: SavedVideo;
  };
  notes: string[];
  /**
   * Format des Browser-Rekorders (nur capture.html).
   */
  mime?: string;
  /**
   * Körpergrösse in Metern, legt den Massstab des Splats fest (nur Mac-App).
   */
  height?: number;
  /**
   * Nur beim Gesichtsscan als eigener Aufnahme: Name der Körper-Aufnahme, auf die der Kopf gehört.
   */
  body?: string;
  /**
   * Zusatzangaben der Mac-App (Kameras, Einstellungen), frei.
   */
  app?: {};
}
export interface SavedVideo {
  /**
   * Dateiname in data/captures/.
   */
  saved: string;
  width: number;
  height: number;
  seconds: number;
}

/**
 * Kameradaten unabhängig von der Auflösung: fx und cx bezogen auf die Bildbreite, fy und cy auf die Bildhöhe. Schreiben: Schachbrett-Kalibrierung (Server) und App-Kameras (app-bridge). Lesen: Tracking.
 */
export interface Intrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  /**
   * OpenCV-Verzeichnung k1, k2, p1, p2, k3. App-Kameras: Nullen, das Bild ist bereits entzerrt.
   *
   * @minItems 5
   * @maxItems 5
   */
  dist: [number, number, number, number, number];
  /**
   * Auflösung, bei der gemessen wurde (Pixel).
   */
  width: number;
  height: number;
  /**
   * Horizontaler Öffnungswinkel in Grad.
   */
  fovX: number;
  /**
   * Vertikaler Öffnungswinkel in Grad.
   */
  fovY: number;
  /**
   * Rückprojektionsfehler in Pixeln (Schachbrett).
   */
  rms?: number;
  /**
   * Anzahl verwendeter Ansichten des Schachbretts.
   */
  views?: number;
  /**
   * App-Kameras: device (vom Gerät gemessen) oder fov (aus dem Öffnungswinkel).
   */
  source?: string;
  /**
   * App-Kameras: corrected, uncorrected oder unknown.
   */
  distortion?: string;
}

export type Hand = ([number, number, number] | null)[] | null;

/**
 * Ein Bild des Live-Trackings, nur Punkte und kein Video. Schreiben: Tracking-Seite, Lesen: Bühne und Regie. Übertragen wird es binär über WebSockets (/ws/send, /ws/stage), Format in web/src/live/protocol.ts; dieses Schema beschreibt das entpackte Bild. Name und Splat-Lauf des Presenters stehen in stage-meta. Koordinaten wie im Avatar (three.js, Meter, relativ zur Hüfte).
 */
export interface LiveFrame {
  /**
   * Zeitpunkt beim Sender in ms (performance.now).
   */
  t: number;
  /**
   * Nur Oberkörper: Hüfte und Beine stehen still.
   */
  upper: boolean;
  mirror: boolean;
  /**
   * Position des Avatars am Boden [x, z] in Metern.
   *
   * @minItems 2
   * @maxItems 2
   */
  pos: [number, number];
  /**
   * 33 Gelenke von MediaPipe Pose, null = unbekannt. Übertragen werden nur die 17, die der Avatar braucht.
   *
   * @minItems 33
   * @maxItems 33
   */
  pts: ([number, number, number] | null)[];
  hands: {
    Left: Hand;
    Right: Hand;
  };
}

/**
 * @minItems 3
 * @maxItems 3
 */
export type Vec3 = [number, number, number];

/**
 * data/runs/<lauf>/rig.json: Gelenke der Person im Splat, in Weltkoordinaten (siehe run-splat). Schreiben: Pipeline (rig). Lesen: Splat-Avatar.
 */
export interface RunRig {
  joints: {
    [k: string]: Vec3;
  };
  /**
   * Woher jedes Gelenk stammt: aus mehreren Bildern trianguliert oder ersatzweise aus einem Bild.
   */
  source: {
    [k: string]: "trianguliert" | "ein Bild";
  };
}

/**
 * data/runs/<lauf>/smplx.json: SMPL-X-Skelett eines Avatars von LHM++, in Weltkoordinaten (siehe run-splat, Füsse bei y = 0). Die Gewichte stehen daneben in smplx_skin.bin: count x 4 Gelenk-Indizes (uint8), danach count x 4 Gewichte (uint8, 0 bis 255, Summe etwa 255), in der Reihenfolge der Kleckse in splat.ply. Schreiben: scripts/pod-do/lhm_zum_viewer.py. Lesen: Splat-Avatar.
 */
export interface RunSmplx {
  /**
   * Die 55 Gelenke von SMPL-X in der Haltung von splat.ply (Becken, Hüften, Wirbelsäule, Knie, ..., Hände).
   *
   * @minItems 55
   * @maxItems 55
   */
  joints: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number]
  ];
  /**
   * Elterngelenk jedes Gelenks, -1 für das Becken.
   *
   * @minItems 55
   * @maxItems 55
   */
  parents: [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number
  ];
  /**
   * Anzahl Kleckse in splat.ply und smplx_skin.bin.
   */
  count: number;
}

/**
 * data/runs/<lauf>/splat.json: bildet die Koordinaten von splat.ply (COLMAP) auf die Welt ab. Welt: Meter, y oben, Füsse bei y = 0, Person schaut nach +z. Schreiben: Pipeline (align). Lesen: Viewer, Avatar, Rig, merge-head.
 */
export interface RunSplat {
  /**
   * 4x4, zeilenweise: matrix[zeile][spalte].
   *
   * @minItems 4
   * @maxItems 4
   */
  matrix: [
    [number, number, number, number],
    [number, number, number, number],
    [number, number, number, number],
    [number, number, number, number]
  ];
  /**
   * Körpergrösse in Metern, aus der der Massstab folgt.
   */
  height: number;
}

/**
 * Name und Splat-Lauf eines Presenters auf der Bühne. Schreiben: Tracking-Seite (Text über /ws/send, nur bei Änderung). Lesen: Bühne und Regie (/ws/stage), damit sie den Splat schon vor dem ersten Bild laden. Der Server merkt sich den letzten Stand pro Platz in data/stage/seats.json.
 */
export interface StageMeta {
  /**
   * Angezeigter Name, leer = «Platz A» bzw. «Platz B».
   */
  name: string;
  /**
   * Lauf, dessen Splat die Tracking-Seite zeigt, leer = nur Roboter.
   */
  run: string;
}

/**
 * Stand der Folien auf der Bühne. Schreiben: Server (nach POST /api/slides und /api/slide aus der Regie). Lesen: Bühne und Regie (/ws/stage). Das PDF liegt unter /stage/slides.pdf?v=<doc>, gespeichert in data/stage/.
 */
export interface StageSlides {
  /**
   * Kennung der hochgeladenen Fassung, null = keine Folien.
   */
  doc: string | null;
  /**
   * Aktuelle Folie, ab 1.
   */
  page: number;
  /**
   * Anzahl Folien, 0 = noch unbekannt (die Regie meldet sie nach dem Laden).
   */
  pages: number;
  /**
   * Dateiname beim Hochladen.
   */
  name?: string;
}
