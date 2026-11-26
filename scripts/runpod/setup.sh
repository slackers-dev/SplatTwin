#!/usr/bin/env bash
# Richtet LHM++ einmalig auf einem RunPod-Pod ein. Laeuft AUF DEM POD, gestartet vom Mac mit
# `make lhm-setup`. Alles landet auf dem Network Volume unter /workspace und bleibt erhalten, wenn
# der Pod gestoppt wird. Ein zweiter Lauf ueberspringt, was schon da ist.
#
# Erwartet: Pod-Vorlage mit CUDA 12.1 (devel, mit nvcc), z. B. "RunPod PyTorch 2.x CUDA 12.1".
# Versionen wie im README von LHM++: Python 3.10, torch 2.3.0, CUDA 12.1.
#
# NOCH NICHT GETESTET auf einem echten Pod (Stand 26.11.2026). Siehe scripts/runpod/README.md.
set -euo pipefail

WS="${WORKSPACE:-/workspace}"
LHM="$WS/LHM-plusplus"
VENV="$LHM/.venv"
export HF_HOME="$WS/cache/huggingface"
export MODELSCOPE_CACHE="$WS/cache/modelscope"
export UV_CACHE_DIR="$WS/cache/uv"
export PATH="$HOME/.local/bin:$PATH"

step() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nFEHLER: %s\n' "$*" >&2; exit 1; }

step "GPU und CUDA pruefen"
command -v nvidia-smi >/dev/null || fail "keine GPU gefunden (nvidia-smi fehlt)"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
if command -v nvcc >/dev/null; then
  nvcc --version | tail -n 1
  nvcc --version | grep -q "release 12\." || echo "WARNUNG: nvcc ist nicht CUDA 12.x, Bauen der Erweiterungen kann scheitern"
else
  fail "nvcc fehlt: eine Vorlage mit CUDA-devel waehlen (z. B. runpod/pytorch ...-cuda12.1.1-devel)"
fi
[ -d "$WS" ] || fail "$WS fehlt: Network Volume an den Pod haengen"

step "Systempakete"
if ! command -v git >/dev/null || ! dpkg -s libgl1 >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git libgl1 libglib2.0-0 ffmpeg >/dev/null
fi

step "uv"
command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh

step "LHM++ klonen"
if [ -d "$LHM/.git" ]; then
  git -C "$LHM" pull --ff-only || echo "WARNUNG: git pull ging nicht, bleibe beim vorhandenen Stand"
else
  git clone https://github.com/aigc3d/LHM-plusplus "$LHM"
fi
cd "$LHM"

step "Python 3.10 Umgebung"
[ -x "$VENV/bin/python" ] || uv venv --python 3.10 "$VENV"
# shellcheck disable=SC1091
source "$VENV/bin/activate"
PIP=(uv pip install)

if [ ! -f "$VENV/.splattwin-ok" ]; then
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

  touch "$VENV/.splattwin-ok"
else
  echo "Pakete schon installiert (zum Neuinstallieren $VENV/.splattwin-ok loeschen)"
fi

step "Pakete pruefen"
python - <<'EOF'
import torch
print("torch", torch.__version__, "CUDA", torch.version.cuda, "GPU verfuegbar:", torch.cuda.is_available())
assert torch.cuda.is_available(), "torch sieht keine GPU"
import gsplat, pytorch3d, xformers  # noqa: F401
import diff_gaussian_rasterization, simple_knn  # noqa: F401
print("Erweiterungen OK")
EOF

step "Modelle laden (Prior-Modelle und LHMPP-700M-PixelShuffle)"
python scripts/download_pretrained_models.py --prior
python - <<'EOF'
from core.utils.model_download_utils import AutoModelQuery
print(AutoModelQuery(save_dir="./pretrained_models").query("LHMPP-700M-PixelShuffle"))
EOF

step "Probelauf mit den Beispielbildern von LHM++"
python scripts/inference/to_gs_ply.py \
  --image_glob "./assets/example_multi_images/00000_yuliang_*.png" \
  --output "$WS/lhm-jobs/probe/avatar.ply"
ls -lh "$WS/lhm-jobs/probe/avatar.ply"

printf '\nFertig. LHM++ liegt in %s. Pod darf jetzt gestoppt werden.\n' "$LHM"
