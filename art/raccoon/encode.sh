#!/usr/bin/env bash
# Turn rendered frames and stills into web assets in public/raccoon.
# usage: encode.sh PASSDIR STILLSDIR
pass=$1; stills=$2
here=$(cd "$(dirname "$0")" && pwd)
dest="$here/../../public/raccoon"
mkdir -p "$dest"
declare -A poster=([1]=0 [2]=12 [3]=12 [4]=20 [5]=3)
for m in 1 2 3 4 5; do
  d="$pass/m$m"
  [ "$(ls "$d" 2>/dev/null | wc -l)" = "96" ] || { echo "m$m incomplete: $(ls "$d" 2>/dev/null | wc -l)"; continue; }
  ffmpeg -y -loglevel error -framerate 24 -i "$d/%04d.png" -c:v libx264 -preset slow -crf 21 -pix_fmt yuv420p -movflags +faststart -an "$dest/hero-m$m.mp4"
  ffmpeg -y -loglevel error -framerate 24 -i "$d/%04d.png" -c:v libvpx-vp9 -crf 31 -b:v 0 -row-mt 1 -pix_fmt yuv420p -an "$dest/hero-m$m.webm"
  magick "$d/$(printf %04d "${poster[$m]}").png" -quality 82 "$dest/hero-m$m.webp"
done
for m in 1 2 3 4 5; do
  [ -f "$stills/icon-m$m.png" ] && magick "$stills/icon-m$m.png" -trim +repage -resize 184x184 -background none -gravity center -extent 184x184 -quality 86 -define webp:alpha-quality=92 "$dest/icon-m$m.webp"
  [ -f "$stills/face-m$m.png" ] && magick "$stills/face-m$m.png" -trim +repage -resize 96x96 -background none -gravity center -extent 96x96 -quality 88 -define webp:alpha-quality=92 "$dest/face-m$m.webp"
done
if [ -f "$stills/face-m2.png" ]; then
  magick "$stills/face-m2.png" -trim +repage -resize 64x64 -background none -gravity center -extent 64x64 "$dest/favicon-64.png"
  magick "$stills/face-m2.png" -trim +repage -resize 150x150 -background '#F1E6BD' -gravity center -extent 180x180 -alpha remove "$dest/apple-touch-icon.png"
fi
ls -la "$dest" | awk '{print $5, $9}' | column -t
