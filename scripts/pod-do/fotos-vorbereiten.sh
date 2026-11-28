#!/usr/bin/env bash
# Sammelt Fotos fuer LHM++ in data/lhm/<name>/fotos: JPG und PNG kopieren, HEIC vom iPhone in JPG
# umwandeln (sips, macOS). Laeuft LOKAL als `before` von pod-do (siehe pod-do.toml), mit $FOTOS und $NAME.
set -euo pipefail

src="${FOTOS:?FOTOS fehlt}"
[ -d "$src" ] || { echo "FEHLER: $src ist kein Ordner" >&2; exit 1; }
out="data/lhm/$NAME/fotos"
rm -rf "$out" && mkdir -p "$out"

n=0
shopt -s nullglob nocaseglob
for f in "$src"/*.{jpg,jpeg,png,heic}; do
  case "${f##*.}" in
    [hH][eE][iI][cC]) sips -s format jpeg "$f" --out "$out/$(basename "${f%.*}").jpg" >/dev/null ;;
    *) cp "$f" "$out/" ;;
  esac
  n=$((n + 1))
done
[ "$n" -gt 0 ] || { echo "FEHLER: keine Fotos (jpg, png, heic) in $src" >&2; exit 1; }
# LHM++ ist mit bis zu 16 Ansichten angegeben
[ "$n" -le 16 ] || echo "Hinweis: $n Fotos, LHM++ nimmt die ersten 16 (alphabetisch)."
echo "$n Fotos in $out"
