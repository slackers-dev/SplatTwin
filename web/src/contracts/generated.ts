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
 * Ein Bild des Live-Trackings, nur Punkte und kein Video. Schreiben: Tracking-Seite (POST /api/live). Lesen: Zuschauerseite (GET /api/live, Server-Sent Events). Koordinaten wie im Avatar (three.js, Meter, relativ zur Hüfte).
 */
export interface LiveFrame {
  /**
   * Zeitpunkt beim Sender in ms (performance.now).
   */
  t: number;
  /**
   * Lauf, dessen Splat die Tracking-Seite zeigt.
   */
  run: string;
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
   * 33 Gelenke von MediaPipe Pose, null = unbekannt.
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
