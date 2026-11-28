#!/usr/bin/env bash
# Richtet ExAvatar (Fitting und Avatar) einmalig ein. Laeuft AUF DEM POD, gestartet von pod-do.
# Installiert nach $POD_DO_ENV, pod-do sichert den Ordner danach als Archiv auf dem Global Volume.
#
# Bewusst nicht die Versionen aus environment.yml (torch 2.6): mmcv 2.1 und pytorch3d gibt es fertig nur
# fuer aeltere torch-Versionen, und torch 2.6 laedt alte Checkpoints nicht mehr ohne weights_only=False.
# Darum torch 2.1.2 mit CUDA 12.1, fertige Pakete fuer mmcv und pytorch3d. Gebaut wird nur der
# Gaussian-Rasterizer mit Tiefe.
#
# Die Koerpermodelle (SMPL-X, FLAME, SMPL) sind lizenziert und kommen NICHT in die Umgebung. Die Aufgabe
# laedt sie bei jedem Lauf hoch (scripts/pod-do/exavatar_modelle.sh legt sie an die richtigen Orte).
set -euo pipefail

step() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nFEHLER: %s\n' "$*" >&2; exit 1; }

# Downloads ausserhalb der Umgebung zwischenspeichern: scheitert setup, geht der naechste Versuch auf
# demselben Pod schneller (pod-do loescht die Umgebung vor jedem setup).
DL=/opt/pod-do/cache/dl
mkdir -p "$DL"
fetch() { # fetch <url> <ziel>
  local name; name=$(basename "$2")
  if [ ! -s "$DL/$name" ]; then
    curl -fsSL --retry 3 -o "$DL/$name.part" "$1" || fail "Download $1"
    mv "$DL/$name.part" "$DL/$name"
  fi
  mkdir -p "$(dirname "$2")"
  cp "$DL/$name" "$2"
  [ -s "$2" ] || fail "$2 fehlt"
}
gfetch() { # gfetch <google-drive-id> <ziel>
  local name; name=$(basename "$2")
  [ -s "$DL/$name" ] || gdown --quiet "$1" -O "$DL/$name" || fail "Google Drive $1"
  mkdir -p "$(dirname "$2")"
  cp "$DL/$name" "$2"
  [ -s "$2" ] || fail "$2 fehlt"
}

step "GPU und CUDA pruefen"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || fail "keine GPU (nvidia-smi)"
command -v nvcc >/dev/null || fail "nvcc fehlt: ein Image mit CUDA-devel waehlen"
nvcc --version | tail -n 1

step "ExAvatar und Werkzeuge klonen"
cd "$POD_DO_ENV"
git clone --depth 1 https://github.com/mks0601/ExAvatar_RELEASE ExAvatar
T="$POD_DO_ENV/ExAvatar/fitting/tools"
git clone --depth 1 https://github.com/yfeng95/DECA "$T/DECA"
git clone --depth 1 https://github.com/mks0601/Hand4Whole_RELEASE "$T/Hand4Whole_RELEASE"
git clone --depth 1 https://github.com/open-mmlab/mmpose "$T/mmpose"
git clone --depth 1 https://github.com/facebookresearch/segment-anything "$T/segment-anything"
git clone --depth 1 https://github.com/DepthAnything/Depth-Anything-V2 "$T/Depth-Anything-V2"
git clone --recursive --depth 1 https://github.com/leo-frank/diff-gaussian-rasterization-depth \
  "$POD_DO_ENV/diff-gaussian-rasterization-depth"
(cd "$T" && python3 copy_code.py)
# Eigene Videos: Datensatz Custom auch beim Avatar
sed -i "s/^\(\s*dataset = \)'NeuMan'/\1'Custom'/" "$POD_DO_ENV/ExAvatar/avatar/main/config.py"
grep -n "dataset = 'Custom'" "$POD_DO_ENV/ExAvatar/avatar/main/config.py" || fail "config.py nicht angepasst"

step "Python 3.10 Umgebung"
uv venv --python 3.10 "$POD_DO_ENV/.venv"
# shellcheck disable=SC1091
source "$POD_DO_ENV/.venv/bin/activate"
PIP=(uv pip install)
# torch 2.1 baut Erweiterungen mit pkg_resources, das gibt es ab setuptools 70 nicht mehr
"${PIP[@]}" pip "setuptools<70" wheel ninja

step "torch 2.1.2 (CUDA 12.1)"
"${PIP[@]}" torch==2.1.2 torchvision==0.16.2 --index-url https://download.pytorch.org/whl/cu121

step "mmcv und pytorch3d als fertige Pakete"
"${PIP[@]}" mmcv==2.1.0 -f https://download.openmmlab.com/mmcv/dist/cu121/torch2.1.0/index.html
"${PIP[@]}" fvcore iopath
"${PIP[@]}" --no-index --no-deps pytorch3d \
  -f https://dl.fbaipublicfiles.com/pytorch3d/packaging/wheels/py310_cu121_pyt212/download.html

step "Uebrige Pakete"
# chumpy 0.71 nur auf GitHub (laeuft mit numpy 1.24+), setup.py importiert pip: ohne Isolation bauen
"${PIP[@]}" --no-build-isolation "chumpy @ git+https://github.com/mattloper/chumpy"
"${PIP[@]}" numpy==1.26.4 mmdet==3.3.0 mmengine==0.10.7 smplx==0.1.28 face-alignment==1.3.4 \
  torchgeometry==0.1.2 lpips kornia==0.7.2 yacs scikit-image opencv-python==4.10.0.84 \
  PyOpenGL==3.1.5 trimesh plyfile xtcocotools munkres json_tricks gdown tqdm matplotlib scipy timm \
  tensorboard easydict
"${PIP[@]}" --no-build-isolation -e "$T/mmpose" -e "$T/segment-anything"
# pyrender verlangt PyOpenGL 3.1.0, fuer EGL ohne Bildschirm braucht es 3.1.5: ohne Abhaengigkeiten
"${PIP[@]}" --no-deps pyrender==0.1.45
"${PIP[@]}" freetype-py imageio networkx "pyglet<2" six
# mmpose zieht sonst ein neueres numpy nach
"${PIP[@]}" numpy==1.26.4

step "torchgeometry flicken (bool-Masken, siehe README von Hand4Whole)"
TG=$(python -c "import torchgeometry, os; print(os.path.dirname(torchgeometry.__file__))")/core/conversions.py
sed -i 's/(1 - mask_\([a-z0-9_]*\))/(~mask_\1)/g' "$TG"
grep -c '~mask_' "$TG"

step "Gaussian-Rasterizer mit Tiefe bauen"
export TORCH_CUDA_ARCH_LIST="${TORCH_CUDA_ARCH_LIST:-8.0;8.6;8.9;9.0}"
H="$POD_DO_ENV/diff-gaussian-rasterization-depth/cuda_rasterizer/rasterizer_impl.h"
grep -q '<cstdint>' "$H" || sed -i '0,/#include/s//#include <cstdint>\n#include/' "$H"
"${PIP[@]}" "setuptools<70"
"${PIP[@]}" --no-build-isolation "$POD_DO_ENV/diff-gaussian-rasterization-depth"

step "Pakete pruefen"
python - <<'EOF'
import torch
print("torch", torch.__version__, "CUDA", torch.version.cuda, "GPU:", torch.cuda.is_available())
assert torch.cuda.is_available(), "torch sieht keine GPU"
import chumpy, smplx, pytorch3d, mmcv, mmdet, mmpose, segment_anything, face_alignment, torchgeometry  # noqa
import diff_gaussian_rasterization_depth  # noqa
from mmcv.ops import nms  # noqa: kompilierte mmcv-Operationen
print("Pakete OK, numpy", __import__("numpy").__version__)
EOF

step "Freie Modelle laden"
fetch https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/rtmdet_m_8xb32-100e_coco-obj365-person-235e8209.pth \
  "$T/mmpose/rtmdet_m_8xb32-100e_coco-obj365-person-235e8209.pth"
fetch https://huggingface.co/yzd-v/DWPose/resolve/main/dw-ll_ucoco_384.pth "$T/mmpose/dw-ll_ucoco_384.pth"
fetch https://dl.fbaipublicfiles.com/segment_anything/sam_vit_h_4b8939.pth "$T/segment-anything/sam_vit_h_4b8939.pth"
fetch https://huggingface.co/depth-anything/Depth-Anything-V2-Large/resolve/main/depth_anything_v2_vitl.pth \
  "$T/Depth-Anything-V2/checkpoints/depth_anything_v2_vitl.pth"
gfetch 1rp8kdyLPvErw2dTmqtjISRVvQLj6Yzje "$T/DECA/data/deca_model.tar"
gfetch 1r0LfI_ATI8NmhOj4y8eqLlEDdNQj5SCV "$T/Hand4Whole_RELEASE/demo/snapshot_6.pth.tar"
for f in flame_static_embedding.pkl flame_dynamic_embedding.npy; do
  fetch "https://raw.githubusercontent.com/soubhiksanyal/RingNet/master/flame_model/$f" "$POD_DO_ENV/free/$f"
done
fetch https://huggingface.co/camenduru/SMPLer-X/resolve/main/SMPLX_to_J14.pkl "$POD_DO_ENV/free/SMPLX_to_J14.pkl"
du -sh "$T"/*/ "$POD_DO_ENV/free"

step "Gewichte, die sonst erst beim ersten Lauf kommen (landen in TORCH_HOME, also im Archiv)"
python - <<'EOF'
import face_alignment
from torchvision.models.detection import fasterrcnn_resnet50_fpn
fasterrcnn_resnet50_fpn(pretrained=True)
face_alignment.FaceAlignment(face_alignment.LandmarksType._2D, device="cpu", flip_input=False)
print("Laufzeit-Gewichte OK")
EOF

step "Probelauf: Person und Ganzkoerper-Punkte auf einem Testbild (mmdet, mmpose, mmcv-Operationen)"
cd "$T/mmpose"
cp "$T/Hand4Whole_RELEASE/demo/input.png" /tmp/probe.png
python - <<'EOF'
import numpy as np
from mmdet.apis import inference_detector, init_detector
from mmpose.apis import inference_topdown, init_model
det = init_detector("demo/mmdetection_cfg/rtmdet_m_640-8xb32_coco-person.py",
                    "rtmdet_m_8xb32-100e_coco-obj365-person-235e8209.pth", device="cuda:0")
r = inference_detector(det, "/tmp/probe.png").pred_instances
boxes = r.bboxes[r.scores > 0.5].cpu().numpy()
print("Personen:", len(boxes))
assert len(boxes) > 0
pose = init_model("configs/wholebody_2d_keypoint/rtmpose/ubody/rtmpose-l_8xb32-270e_coco-ubody-wholebody-384x288.py",
                  "dw-ll_ucoco_384.pth", device="cuda:0")
k = inference_topdown(pose, "/tmp/probe.png", boxes)[0].pred_instances.keypoints
print("Punkte pro Person:", k.shape)
assert k.shape[1] == 133
EOF
echo "ExAvatar eingerichtet"
