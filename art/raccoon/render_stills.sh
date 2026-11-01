#!/usr/bin/env bash
# Transparent stills for the small spots: full-body icons and head-only faces.
# usage: render_stills.sh OUTDIR [samples]
out=$1; samples=${2:-32}
here=$(cd "$(dirname "$0")" && pwd)
blender=${BLENDER:-$HOME/.local/opt/blender/blender}
mkdir -p "$out"
for m in 1 2 3 4 5; do
  "$blender" -b -P "$here/build.py" -- --mood "$m" --frames 96 --frame 12 --res 420 --samples "$samples" --fur 1 --alpha 1 --shot icon --out "$out/icon-m$m.png" 2>&1 | grep -E "Error|Traceback" | tail -2
  "$blender" -b -P "$here/build.py" -- --mood "$m" --frames 96 --frame 12 --res 192 --samples "$samples" --fur 1 --alpha 1 --shot mark --out "$out/face-m$m.png" 2>&1 | grep -E "Error|Traceback" | tail -2
done
echo STILLSDONE
