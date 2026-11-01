# Raccoon art

The mood-meter raccoon is a procedural 3D character. `build.py` creates the model,
fur, green bin, lighting and all five moods from code in Blender, so it can be
restyled and re-rendered instead of being redrawn by hand.

Nothing in this folder is served. The site only uses the finished files in
`public/raccoon/`.

## The five moods

| Mood | Label | Scene |
|---|---|---|
| 1 | All clear | Asleep beside the bin, holding a slice of pizza, Z's drifting up |
| 2 | Faint | Awake and sniffing, ears twitching, a little vapour off the bin |
| 3 | Noticeable | Squinting and fanning the air with one paw |
| 4 | Strong | Eyes squeezed shut, paws on its nose, crying |
| 5 | Overwhelming | Gas mask on, running from the tipped bin through green haze |

Each mood is a four-second seamless loop at 24 fps. Scene colours match the
`--mood-bg` values in `public/styles/main.css`.

## Regenerating

Needs Blender 4.5. Set `BLENDER` if it isn't at `~/.local/opt/blender/blender`.

```sh
art/raccoon/render_all.sh art/raccoon/out/pass1 640 20      # about 2.5 hours on a laptop
art/raccoon/render_stills.sh art/raccoon/out/stills         # about 5 minutes
art/raccoon/encode.sh "$PWD/art/raccoon/out/pass1" "$PWD/art/raccoon/out/stills"
```

`render_all.sh` skips finished frames, so it can be restarted. To redo one mood, delete
its folder and pass the mood: `render_all.sh art/raccoon/out/pass1 640 20 '3'`.
Files in `out/` aren't committed.

The share image is a wide render with the title set over it in the site's own fonts:

```sh
blender -b -P art/raccoon/build.py -- --mood 3 --frames 96 --frame 12 --res 630 --samples 32 --fur 1 --shot share --out /tmp/share.png
node art/raccoon/share-card.js /tmp/share.png     # needs the preview server running
```

## Previewing

```sh
node art/raccoon/preview-server.js
```

Then open `http://localhost:4173/raccoon-lab`. It serves `public/` with the production
security headers and answers `/api` from `out/fixtures.json`, a saved copy of the site's
public data. Add `?mood=1` to `5` on the dashboard to see any state on the real page.

## Things that are easy to break

- Fur comb direction cancels fur that grows against it. A strong comb makes the side of
  the head facing that direction look bald.
- Fur length and fur density are separate vertex groups. Only thin the density around
  the eyes and nose, or skin shows through.
- Render settings use the Standard view transform so the set matches the page colours.
- Clouds must stay behind the character and bin, or they tint the fur green.
- The status bar overlaps the bottom of the hero card, so keep the feet above it.
- Paws are as dark as the nose. In mood 4 they merge into one big snout if they get any
  closer, and past 35 degrees the arms cross and the paws slide apart. Mood 3's sweep stops
  short of the muzzle for the same reason.
- Moods 3 and 4 need long arms (`scale` 1.46 or more), or the paws stop under the chin.
- Mood 5's bounce must peak at full stride. The other way round, its feet float and its
  rump hits the floor.
- Blender's frames are cheap to test. Render a single frame at `--res 480 --samples 10`
  (about 30 seconds) before committing to a 25-minute mood.
