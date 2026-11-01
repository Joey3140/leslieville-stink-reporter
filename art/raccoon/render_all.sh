#!/usr/bin/env bash
# Render every mood's full loop. Resumable: finished frames are skipped.
# usage: render_all.sh OUTDIR RES SAMPLES [moods] [frames]
out=$1; res=$2; samples=$3; moods=${4:-1 2 3 4 5}; frames=${5:-96}
here=$(cd "$(dirname "$0")" && pwd)
blender=${BLENDER:-$HOME/.local/opt/blender/blender}
for m in $moods; do
  mkdir -p "$out/m$m"
  "$blender" -b -P "$here/build.py" -- --mood "$m" --frames "$frames" --frame 0 --end "$frames" \
    --res "$res" --samples "$samples" --fur 1 --out "$out/m$m/####.png" 2>&1 | grep -E "Error|Traceback|Saved" | tail -2
  echo "mood $m done $(date +%H:%M:%S)"
done
echo ALLDONE
