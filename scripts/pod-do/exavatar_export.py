"""Exportiert einen trainierten ExAvatar als Splat (PLY) mit SMPL-X-Gewichten (skin.npz).

Laeuft AUF DEM POD im Ordner ExAvatar/avatar/main. ExAvatar speichert keine Gaussians, sondern Netze
(Triplanes und MLPs), die sie pro Pose berechnen. Hier werden sie einmal in der kanonischen Haltung von
ExAvatar ausgewertet (SMPL-X-Koordinaten: y oben, Blick nach +z, Beine leicht gespreizt), ohne die
posenabhaengigen Korrekturen. Ausgabe im selben Format wie bei LHM++ (siehe lhm_export.py):

- avatar.ply: 3DGS-PLY (f_dc, opacity als Logit, scale als log, rot), ExAvatar: isotrop, deckend
- skin.npz:   weights [N, 55] float16, joints [55, 3], parents [55]

Aufruf: python exavatar_export.py --subject_id <name> --test_epoch 4 --output <ordner>
"""

import argparse
import json
import os
import os.path as osp
import sys

sys.path.insert(0, os.getcwd())  # config.py und base.py liegen in avatar/main

import numpy as np
import torch
from base import Tester
from config import cfg
from plyfile import PlyData, PlyElement
from pytorch3d.ops import knn_points
from utils.smpl_x import smpl_x

SH_C0 = 0.28209479177387814


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--subject_id", required=True)
    ap.add_argument("--test_epoch", default="4")
    ap.add_argument("--output", required=True)
    args = ap.parse_args()
    cfg.set_args(args.subject_id)
    tester = Tester(args.test_epoch)

    # ID-Parameter wie in get_neutral_pose.py
    root = osp.join(
        "..", "data", cfg.dataset, "data", cfg.subject_id, "smplx_optimized"
    )

    def load(name: str) -> torch.Tensor:
        with open(osp.join(root, name + ".json")) as f:
            return torch.FloatTensor(json.load(f))

    smpl_x.set_id_info(
        load("shape_param"),
        load("face_offset"),
        load("joint_offset"),
        load("locator_offset"),
    )
    tester.smplx_params = None
    tester._make_model()
    hg = tester.model.module.human_gaussian

    with torch.no_grad():
        mesh, mesh_lr, joints, _ = hg.get_neutral_pose_human(
            jaw_zero_pose=True, use_id_info=True
        )
        tri = hg.extract_tri_feature()
        geo = hg.geo_net(tri)
        xyz = mesh + hg.mean_offset_net(geo)
        scale = torch.exp(hg.scale_net(geo)).repeat(1, 3)
        rgb = (torch.tanh(hg.rgb_net(tri)) + 1) / 2
        # Gewichte wie in HumanGaussian.forward: naechster Knoten, Haende und Gesicht eigene Gewichte
        nn = knn_points(xyz[None], mesh_lr[None], K=1).idx[0, :, 0]
        nn = hg.lr_idx_to_hr_idx(nn)
        own = (hg.is_rhand + hg.is_lhand + hg.is_face) > 0
        nn[own] = torch.arange(smpl_x.vertex_num_upsampled).cuda()[own]
        weights = hg.skinning_weight[nn]

    xyz = xyz.cpu().numpy().astype(np.float32)
    scale = scale.cpu().numpy().astype(np.float32)
    rgb = rgb.cpu().numpy().astype(np.float32)
    n = len(xyz)
    os.makedirs(args.output, exist_ok=True)

    fields = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
              "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]  # fmt: skip
    data = np.zeros(n, dtype=[(f, "f4") for f in fields])
    for i, a in enumerate("xyz"):
        data[a] = xyz[:, i]
    for i in range(3):
        data[f"f_dc_{i}"] = (rgb[:, i] - 0.5) / SH_C0
        data[f"scale_{i}"] = np.log(np.maximum(scale[:, i], 1e-7))
    data["opacity"] = (
        6.0  # deckend (sigmoid(6) = 0.9975), ExAvatar rechnet mit Deckkraft 1
    )
    data["rot_0"] = 1.0
    PlyData([PlyElement.describe(data, "vertex")]).write(
        osp.join(args.output, "avatar.ply")
    )

    np.savez_compressed(
        osp.join(args.output, "skin.npz"),
        weights=weights.cpu().numpy().astype(np.float16),
        joints=joints.cpu().numpy().astype(np.float32),
        parents=hg.smplx_layer.parents.cpu().numpy().astype(np.int64),
    )
    print(
        f"Export: {n} Gaussians, {weights.shape[1]} Gelenke, Hoehe {xyz[:, 1].max() - xyz[:, 1].min():.2f}"
    )


if __name__ == "__main__":
    main()
