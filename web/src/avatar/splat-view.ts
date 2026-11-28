// Ansicht eines Splat-Avatars: Splat oder Roboter, oder beide uebereinander, um die Zuordnung zu pruefen.
// Gemeinsam fuer den Weg ueber das Roboter-Skelett (splat-avatar.ts) und ueber SMPL-X (smplx-avatar.ts).
import type { SplatMesh } from '@sparkjsdev/spark';
import type * as THREE from 'three';
import type { Retargeter } from './retarget';

export interface SplatView {
  /** Splat statt Roboter zeigen */
  splat: boolean;
  /** Roboter durchsichtig unter dem Splat, 0 = aus */
  robotOpacity: number;
  splatOpacity: number;
  /** durchsichtigen Roboter als Drahtgitter */
  wireframe: boolean;
}

export interface SplatAvatar {
  count: number;
  /** Teilweise Aenderung, z. B. setView({ robotOpacity: 0.4 }). */
  setView(change: Partial<SplatView>): void;
  setVisible(on: boolean): void;
  /** Splat entfernen (z. B. anderer Lauf), der Roboter ist danach wieder sichtbar. */
  dispose(): void;
}

/** Die Netze des Roboters (fuer Sichtbarkeit und Schleier). */
export function robotMeshes(retargeter: Retargeter): THREE.SkinnedMesh[] {
  const robot: THREE.SkinnedMesh[] = [];
  retargeter.model.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) robot.push(o as THREE.SkinnedMesh);
  });
  return robot;
}

/**
 * Steuert, was zu sehen ist. Der durchsichtige Roboter wird nach dem Splat gezeichnet (renderOrder) und
 * schreibt keine Tiefe, liegt also als Schleier ueber dem Splat: Wo Roboter ohne Splat zu sehen ist oder
 * Splat weit ueber den Roboter hinausragt, stimmt die Zuteilung nicht.
 */
export function splatAvatar(
  retargeter: Retargeter,
  mesh: SplatMesh,
  count: number,
  remove: () => void,
): SplatAvatar {
  const robot = robotMeshes(retargeter);
  const robotMaterials = [...new Set(robot.flatMap((m) => ([] as THREE.Material[]).concat(m.material)))];
  const castShadow = new Map(robot.map((m) => [m, m.castShadow]));
  const view: SplatView = { splat: true, robotOpacity: 0, splatOpacity: 1, wireframe: false };
  const applyView = () => {
    const ghost = view.splat && view.robotOpacity > 0;
    mesh.visible = view.splat;
    mesh.opacity = view.splatOpacity;
    for (const m of robot) {
      m.visible = !view.splat || ghost;
      m.renderOrder = ghost ? 1 : 0;
      m.castShadow = ghost ? false : (castShadow.get(m) ?? true);
    }
    for (const mat of robotMaterials) {
      mat.transparent = ghost;
      mat.opacity = ghost ? view.robotOpacity : 1;
      mat.depthWrite = !ghost;
      if ('wireframe' in mat) (mat as THREE.MeshStandardMaterial).wireframe = ghost && view.wireframe;
      mat.needsUpdate = true;
    }
  };
  applyView();

  const setView = (change: Partial<SplatView>) => {
    Object.assign(view, change);
    applyView();
  };
  return {
    count,
    setView,
    setVisible: (on) => setView({ splat: on }),
    dispose: () => {
      setView({ splat: false });
      remove();
    },
  };
}
