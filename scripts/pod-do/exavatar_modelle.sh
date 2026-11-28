#!/usr/bin/env bash
# Legt die lizenzierten Koerpermodelle (SMPL-X, FLAME, SMPL) dorthin, wo ExAvatar, DECA und Hand4Whole
# sie erwarten. Laeuft AUF DEM POD vor jedem Lauf. Arg 1: Ordner mit den ZIP-Dateien (unveraendert, wie
# von den MPI-Seiten geladen, Liste in data/models/mpi/LIESMICH.md).
set -euo pipefail
ZIPS="$1"
X="$POD_DO_ENV/ExAvatar"
T="$X/fitting/tools"
FREE="$POD_DO_ENV/free"
W=$(mktemp -d)
fail() { printf '\nFEHLER: %s\n' "$*" >&2; exit 1; }

# Jedes ZIP in einen eigenen Ordner: FLAME 2019 und 2020 haben gleich benannte Dateien
for z in "$ZIPS"/*.zip; do
  d="$W/$(basename "$z" .zip)"
  mkdir -p "$d" && unzip -q -o "$z" -d "$d"
done
# find_in <zip-muster> <dateiname>: erste Datei mit diesem Namen in passenden ZIPs
find_in() {
  local hit
  hit=$(find "$W"/$1 -type f -name "$2" 2>/dev/null | head -n 1)
  [ -n "$hit" ] || fail "$2 nicht gefunden (in ZIP $1). ZIPs da: $(ls "$ZIPS")"
  echo "$hit"
}
put() { mkdir -p "$(dirname "$2")"; cp "$1" "$2"; }

SX_N=$(find_in "*smplx*" SMPLX_NEUTRAL.npz)
SX_M=$(find_in "*smplx*" SMPLX_MALE.npz)
SX_F=$(find_in "*smplx*" SMPLX_FEMALE.npz)
SX_FLAME=$(find_in "*" SMPL-X__FLAME_vertex_ids.npy)
SX_MANO=$(find_in "*" MANO_SMPLX_vertex_ids.pkl)
SX_FLIP=$(find_in "*" smplx_flip_correspondences.npz)
SX_UV=$(find_in "*" smplx_uv.obj)
F20_G=$(find_in "*2020*" generic_model.pkl)
F20_M=$(find_in "*2020*" male_model.pkl)
F20_F=$(find_in "*2020*" female_model.pkl)
F19_G=$(find_in "*2019*" generic_model.pkl)
F_TEX=$(find_in "*" FLAME_texture.npz)
S_N=$(find_in "*" "basicmodel_neutral_lbs_10_207_0_v1.1.0.pkl")
S_M=$(find_in "*" "basicmodel_m_lbs_10_207_0_v1.1.0.pkl")
S_F=$(find_in "*" "basicmodel_f_lbs_10_207_0_v1.1.0.pkl")

# ExAvatar: Fitting und Avatar brauchen dieselben Dateien
for part in fitting avatar; do
  H="$X/$part/common/utils/human_model_files"
  put "$SX_N" "$H/smplx/SMPLX_NEUTRAL.npz"; put "$SX_M" "$H/smplx/SMPLX_MALE.npz"; put "$SX_F" "$H/smplx/SMPLX_FEMALE.npz"
  put "$SX_FLAME" "$H/smplx/SMPL-X__FLAME_vertex_ids.npy"; put "$SX_MANO" "$H/smplx/MANO_SMPLX_vertex_ids.pkl"
  put "$SX_FLIP" "$H/smplx/smplx_flip_correspondences.npz"; put "$SX_UV" "$H/smplx/smplx_uv/smplx_uv.obj"
  put "$F20_G" "$H/flame/FLAME_NEUTRAL.pkl"; put "$F20_M" "$H/flame/FLAME_MALE.pkl"; put "$F20_F" "$H/flame/FLAME_FEMALE.pkl"
  put "$F19_G" "$H/flame/2019/generic_model.pkl"; put "$F_TEX" "$H/flame/FLAME_texture.npz"
  put "$FREE/flame_static_embedding.pkl" "$H/flame/flame_static_embedding.pkl"
  put "$FREE/flame_dynamic_embedding.npy" "$H/flame/flame_dynamic_embedding.npy"
done

# Hand4Whole: SMPL und SMPL-X
H="$T/Hand4Whole_RELEASE/common/utils/human_model_files"
put "$S_N" "$H/smpl/SMPL_NEUTRAL.pkl"; put "$S_M" "$H/smpl/SMPL_MALE.pkl"; put "$S_F" "$H/smpl/SMPL_FEMALE.pkl"
put "$SX_N" "$H/smplx/SMPLX_NEUTRAL.npz"; put "$SX_M" "$H/smplx/SMPLX_MALE.npz"; put "$SX_F" "$H/smplx/SMPLX_FEMALE.npz"
put "$FREE/SMPLX_to_J14.pkl" "$H/smplx/SMPLX_to_J14.pkl"
put "$SX_MANO" "$H/smplx/MANO_SMPLX_vertex_ids.pkl"; put "$SX_FLAME" "$H/smplx/SMPL-X__FLAME_vertex_ids.npy"

# DECA: FLAME 2020
put "$F20_G" "$T/DECA/data/generic_model.pkl"
put "$F20_M" "$T/DECA/data/FLAME2020/male_model.pkl"; put "$F20_F" "$T/DECA/data/FLAME2020/female_model.pkl"
put "$F20_G" "$T/DECA/data/FLAME2020/generic_model.pkl"

rm -rf "$W"
echo "Koerpermodelle abgelegt"
