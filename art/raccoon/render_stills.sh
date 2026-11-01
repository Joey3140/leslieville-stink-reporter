#!/usr/bin/env bash
# Transparent stills for the small spots: full-body icons and head-only faces.
# usage: render_stills.sh OUTDIR [samples]
out=$1; samples=${2:-32}
here=$(cd "$(dirname "$0")" && pwd)
blender=${BLENDER:-$HOME/.local/opt/blender/blender}
mkdir -p "$out"
for m in 1 2 3 4 5; do
  # Frame 3 is mood 5 at full stride. Frame 12 would show it standing still.
  frame=12; [ "$m" = 5 ] && frame=3
  "$blender" -b -P "$here/build.py" -- --mood "$m" --frames 96 --frame "$frame" --res 420 --samples "$samples" --fur 1 --alpha 1 --shot icon --out "$out/icon-m$m.png" 2>&1 | grep -E "Error|Traceback" | tail -2
  "$blender" -b -P "$here/build.py" -- --mood "$m" --frames 96 --frame "$frame" --res 192 --samples "$samples" --fur 1 --alpha 1 --shot mark --out "$out/face-m$m.png" 2>&1 | grep -E "Error|Traceback" | tail -2
done
echo STILLSDONE
