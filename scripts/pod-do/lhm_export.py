"""Startet to_gs_ply.py von LHM++ und schreibt zusaetzlich das SMPL-X-Skinning der Gaussians mit.

Laeuft AUF DEM POD im Ordner von LHM++, mit denselben Argumenten wie to_gs_ply.py. Neben das PLY kommt
skin.npz:
- weights: [N, 55] Gewicht jedes Gaussians an jedem SMPL-X-Gelenk (Reihenfolge wie im PLY)
- joints:  [55, 3] Gelenke in der Haltung des PLY (kanonische Haltung von LHM++: Arme 30 Grad unten,
           Beine 15 Grad gespreizt), gleiche Koordinaten wie das PLY
- parents: [55] Elterngelenk, -1 fuer das Becken

LHM++ verformt mit genau diesen Gewichten (voxel-basiertes Linear Blend Skinning). Das Skript haengt sich
dafuer in zwei Methoden der Skinning-Klasse und ruft sie danach unveraendert auf.

    python lhm_export.py --model_name ... --images_dir ... --output out/avatar.ply
"""

import os
import runpy
import sys

import numpy as np

sys.path.insert(0, os.getcwd())

from core.models.rendering.skinnings import smplx_voxel_skinning as voxel

CAPTURE: dict[str, np.ndarray] = {}
Skinning = voxel.SMPLXVoxelSkinning
_vertex = Skinning.get_transform_mat_vertex
_joint = Skinning.get_transform_mat_joint


def get_transform_mat_vertex(self, transform_mat_joint, query_points, fix_mask):
    # Gewichte wie in der Originalmethode, letzte Zeile = kanonische Haltung (der letzte Aufruf ist der Export)
    batch = transform_mat_joint.shape[0]
    w = self.query_voxel_skinning_weights(query_points.view(1, -1, 3)).view(
        batch, -1, transform_mat_joint.shape[1]
    )
    w[fix_mask] = self.skinning_weight.unsqueeze(0).repeat(batch, 1, 1)[fix_mask]
    CAPTURE["weights"] = w[-1].detach().float().cpu().numpy()
    return _vertex(self, transform_mat_joint, query_points, fix_mask)


def get_transform_mat_joint(self, *args, **kwargs):
    transform, posed_joints = _joint(self, *args, **kwargs)
    CAPTURE["joints"] = posed_joints[-1].detach().float().cpu().numpy()
    CAPTURE["parents"] = (
        self.smplx_layer.parents.detach().cpu().numpy().astype(np.int32)
    )
    return transform, posed_joints


Skinning.get_transform_mat_vertex = get_transform_mat_vertex
Skinning.get_transform_mat_joint = get_transform_mat_joint


def main() -> None:
    out = sys.argv[sys.argv.index("--output") + 1]
    sys.argv = ["scripts/inference/to_gs_ply.py", *sys.argv[1:]]
    runpy.run_path("scripts/inference/to_gs_ply.py", run_name="__main__")
    missing = {"weights", "joints", "parents"} - CAPTURE.keys()
    if missing:
        raise SystemExit(f"Skinning nicht mitgeschrieben: {sorted(missing)}")
    w = CAPTURE["weights"]
    path = os.path.join(os.path.dirname(os.path.abspath(out)), "skin.npz")
    np.savez_compressed(
        path,
        weights=w.astype(np.float16),
        joints=CAPTURE["joints"],
        parents=CAPTURE["parents"],
    )
    print(f"Skinning: {w.shape[0]} Gaussians, {w.shape[1]} Gelenke -> {path}")


if __name__ == "__main__":
    main()
