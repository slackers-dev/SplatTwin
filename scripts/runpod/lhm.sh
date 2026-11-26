#!/usr/bin/env bash
# LHM++ auf RunPod vom Mac aus bedienen. Laeuft AUF DEM MAC.
#
#   lhm.sh check                 Pod erreichbar? GPU? LHM++ eingerichtet?
#   lhm.sh setup                 LHM++ einmalig auf dem Pod einrichten (setup.sh)
#   lhm.sh run <fotos> [name]    Fotos hochladen, Avatar rechnen, .ply nach data/lhm/<name>/ holen
#   lhm.sh ssh                   Shell auf dem Pod
#
# Verbindung steht in scripts/runpod/pod.env (nicht im Repo, Vorlage pod.env.example).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DATA="${SPLATTWIN_DATA:-$ROOT/data}"
ENV_FILE="$HERE/pod.env"

fail() { printf 'FEHLER: %s\n' "$*" >&2; exit 1; }

case "${1:-}" in
  check | setup | run | ssh) ;;
  *) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac

[ -f "$ENV_FILE" ] || fail "$ENV_FILE fehlt. Vorlage kopieren: cp $HERE/pod.env.example $ENV_FILE und ausfuellen."
# shellcheck disable=SC1090
source "$ENV_FILE"
: "${POD_HOST:?POD_HOST fehlt in pod.env}"
: "${POD_PORT:?POD_PORT fehlt in pod.env}"
POD_USER="${POD_USER:-root}"
WS="${POD_WORKSPACE:-/workspace}"

SSH_OPTS=(-p "$POD_PORT" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30)
if [ -n "${POD_KEY:-}" ]; then SSH_OPTS+=(-i "$POD_KEY"); fi
SSH=(ssh "${SSH_OPTS[@]}" "$POD_USER@$POD_HOST")
# mit Terminal, damit Strg-C auch auf dem Pod abbricht
SSH_T=(ssh -t "${SSH_OPTS[@]}" "$POD_USER@$POD_HOST")

# Umgebung fuer Befehle auf dem Pod: Caches auf dem Volume, venv von LHM++
REMOTE_ENV="export HF_HOME=$WS/cache/huggingface MODELSCOPE_CACHE=$WS/cache/modelscope; \
cd $WS/LHM-plusplus && source .venv/bin/activate"

cmd_check() {
  echo "Verbinde mit $POD_USER@$POD_HOST:$POD_PORT ..."
  "${SSH[@]}" "nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv,noheader \
    && df -h $WS | tail -n 1 \
    && if [ -f $WS/LHM-plusplus/.venv/.splattwin-ok ]; then echo 'LHM++: eingerichtet'; \
       else echo 'LHM++: noch nicht eingerichtet (make lhm-setup)'; fi"
}

cmd_setup() {
  echo "Kopiere setup.sh auf den Pod und starte es. Log auf dem Pod: $WS/lhm-setup.log"
  "${SSH[@]}" "mkdir -p $WS && cat > $WS/lhm-setup.sh && chmod +x $WS/lhm-setup.sh" < "$HERE/setup.sh"
  "${SSH_T[@]}" "bash $WS/lhm-setup.sh 2>&1 | tee $WS/lhm-setup.log"
}

cmd_run() {
  local src="${1:-}" name="${2:-}"
  [ -n "$src" ] || fail "Ordner mit Fotos fehlt: lhm.sh run <fotos> [name]"
  [ -d "$src" ] || fail "$src ist kein Ordner"
  [ -n "$name" ] || name="$(basename "$(cd "$src" && pwd)")"
  # Name landet in Pfaden auf dem Pod: nur Buchstaben, Ziffern, Punkt, Minus, Unterstrich
  name="$(printf '%s' "$name" | tr -c 'A-Za-z0-9._-' '-')"

  # Fotos sammeln, HEIC vom iPhone mit sips (macOS) in JPG umwandeln
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  local tmp="$TMP"
  local n=0 f
  shopt -s nullglob nocaseglob
  for f in "$src"/*.{jpg,jpeg,png,heic}; do
    case "${f##*.}" in
      [hH][eE][iI][cC]) sips -s format jpeg "$f" --out "$tmp/$(basename "${f%.*}").jpg" >/dev/null ;;
      *) cp "$f" "$tmp/" ;;
    esac
    n=$((n + 1))
  done
  shopt -u nullglob nocaseglob
  [ "$n" -gt 0 ] || fail "keine Fotos (jpg, png, heic) in $src"
  # LHM++ ist mit bis zu 16 Ansichten angegeben
  local views=$((n > 16 ? 16 : n))
  if [ "$n" -gt 16 ]; then echo "Hinweis: $n Fotos, LHM++ nimmt die ersten 16 (alphabetisch)."; fi

  local job="$WS/lhm-jobs/$name"
  echo "Lade $n Fotos hoch nach $job ..."
  "${SSH[@]}" "rm -rf $job/images && mkdir -p $job/images"
  # COPYFILE_DISABLE: ohne die ._-Dateien von macOS
  COPYFILE_DISABLE=1 tar -C "$tmp" -cf - . | "${SSH[@]}" "tar -C $job/images -xf -"

  echo "Rechne Avatar ($views Ansichten) ..."
  "${SSH[@]}" "$REMOTE_ENV && python scripts/inference/to_gs_ply.py \
    --images_dir $job/images --ref_view $views --output $job/avatar.ply"

  local out="$DATA/lhm/$name"
  mkdir -p "$out"
  "${SSH[@]}" "cat $job/avatar.ply" > "$out/avatar.ply"
  [ -s "$out/avatar.ply" ] || fail "avatar.ply ist leer"
  echo "Fertig: $out/avatar.ply ($(du -h "$out/avatar.ply" | cut -f1))"
  echo "Pod stoppen nicht vergessen, wenn du fertig bist."
}

cmd_ssh() { "${SSH_T[@]}" "cd $WS; exec bash -l"; }

case "${1:-}" in
  check) cmd_check ;;
  setup) cmd_setup ;;
  run) shift; cmd_run "$@" ;;
  ssh) cmd_ssh ;;
esac
