#!/usr/bin/env bash
# Richtet LHM++ einmalig ein. Laeuft AUF DEM POD, gestartet von pod-do (siehe pod-do.toml).
# Installiert nach $POD_DO_ENV (Arbeitsverzeichnis), pod-do sichert den Ordner danach als Archiv auf dem
# Global Volume. Die Modelle kommen mit ins Archiv: Global Volumes koennen keine Dateien sperren, das
# brauchen die Download-Skripte.
#
# Versionen wie im README von LHM++: Python 3.10, torch 2.3.0, CUDA 12.1. Das Image muss CUDA-devel
# (nvcc) haben, sonst lassen sich die Erweiterungen nicht bauen.
#
# NOCH NICHT GETESTET auf einem echten Pod (Stand 26.11.2026).
set -euo pipefail

step() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nFEHLER: %s\n' "$*" >&2; exit 1; }

step "GPU und CUDA pruefen"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || fail "keine GPU (nvidia-smi)"
command -v nvcc >/dev/null || fail "nvcc fehlt: ein Image mit CUDA-devel waehlen"
nvcc --version | tail -n 1
nvcc --version | grep -q "release 12\." || echo "WARNUNG: nvcc ist nicht CUDA 12.x, Bauen kann scheitern"

step "LHM++ klonen"
git clone --depth 1 https://github.com/aigc3d/LHM-plusplus "$POD_DO_ENV/LHM-plusplus"
cd "$POD_DO_ENV/LHM-plusplus"

step "Python 3.10 Umgebung"
uv venv --python 3.10 .venv
# shellcheck disable=SC1091
source .venv/bin/activate
PIP=(uv pip install)

step "torch 2.3.0 (CUDA 12.1) und xformers"
"${PIP[@]}" torch==2.3.0 torchvision==0.18.0 torchaudio==2.3.0 --index-url https://download.pytorch.org/whl/cu121
"${PIP[@]}" xformers==0.0.26.post1 --index-url https://download.pytorch.org/whl/cu121

step "gsplat und torch_scatter als fertige Pakete"
"${PIP[@]}" gsplat==1.4.0 --index-url https://docs.gsplat.studio/whl/pt23cu121
"${PIP[@]}" torch_scatter -f https://data.pyg.org/whl/torch-2.3.0+cu121.html

step "Abhaengigkeiten aus requirements.txt"
# torch, xformers und gsplat sind schon da und passen; nicht nochmals von PyPI holen
grep -v -E '^(torch|torchvision|xformers|gsplat)==' requirements.txt > /tmp/lhm-req.txt
"${PIP[@]}" -r /tmp/lhm-req.txt
"${PIP[@]}" "rembg[cpu]" spconv-cu121

step "pytorch3d"
"${PIP[@]}" --no-index --no-cache pytorch3d \
  -f https://dl.fbaipublicfiles.com/pytorch3d/packaging/wheels/py310_cu121_pyt230/download.html

step "CUDA-Erweiterungen bauen (dauert einige Minuten)"
export TORCH_CUDA_ARCH_LIST="${TORCH_CUDA_ARCH_LIST:-8.0;8.6;8.9;9.0}"
"${PIP[@]}" --no-build-isolation ./lib/pointops
"${PIP[@]}" --no-build-isolation git+https://github.com/ashawkey/diff-gaussian-rasterization/
"${PIP[@]}" --no-build-isolation git+https://github.com/camenduru/simple-knn/

step "Pakete pruefen"
python - <<'EOF'
import torch
print("torch", torch.__version__, "CUDA", torch.version.cuda, "GPU verfuegbar:", torch.cuda.is_available())
assert torch.cuda.is_available(), "torch sieht keine GPU"
import gsplat, pytorch3d, xformers  # noqa: F401
import diff_gaussian_rasterization, simple_knn  # noqa: F401
print("Erweiterungen OK")
EOF

step "Modelle (Prior-Modelle und LHMPP-700M-PixelShuffle)"
python scripts/download_pretrained_models.py --prior
python - <<'EOF'
from core.utils.model_download_utils import AutoModelQuery
print(AutoModelQuery(save_dir="./pretrained_models").query("LHMPP-700M-PixelShuffle"))
EOF

step "Probelauf mit den Beispielbildern von LHM++"
python scripts/inference/to_gs_ply.py \
  --image_glob "./assets/example_multi_images/00000_yuliang_*.png" \
  --output "$POD_DO_ENV/probe/avatar.ply"
ls -lh "$POD_DO_ENV/probe/avatar.ply"
