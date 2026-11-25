// Koerperpunkte von MediaPipe Pose (33) und Hands (21) und die Umrechnung in die Achsen des Avatars.
import type { Vec3 } from './vec';

/** Bildpunkt: x, y in 0..1 (Anteil an Bildbreite und -hoehe). */
export interface Landmark2D {
  x: number;
  y: number;
}

/** Punkt von MediaPipe: Bildpunkt (landmarks) oder Weltpunkt in Metern relativ zur Huefte (worldLandmarks). */
export interface Landmark extends Landmark2D {
  z: number;
  visibility?: number;
}

export const POSE_COUNT = 33;
export const HAND_COUNT = 21;

/** Indizes von MediaPipe Pose, die im Projekt gebraucht werden. */
export const LM = {
  nose: 0, lEar: 7, rEar: 8,
  lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16,
  lHip: 23, rHip: 24, lKn: 25, rKn: 26, lAn: 27, rAn: 28, lToe: 31, rToe: 32,
} as const;
export type JointName = keyof typeof LM;

/** Knochen des Kontroll-Skeletts (Paare von Indizes). */
export const POSE_BONES: [number, number][] = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [27, 31], [24, 26], [26, 28], [28, 32], [7, 0], [8, 0],
];

/**
 * MediaPipe-Weltkoordinaten (y nach unten, z von der Kamera weg) -> Achsen des Avatars wie in three.js
 * (x = links der Person, y oben, z zum Betrachter).
 */
export const toThree = (l: Landmark): Vec3 => [l.x, -l.y, -l.z];

/** Kamerakoordinaten (x rechts, y unten, z in Blickrichtung) -> Achsen des Avatars. */
export const camToThree = (p: Vec3): Vec3 => [p[0], -p[1], -p[2]];
