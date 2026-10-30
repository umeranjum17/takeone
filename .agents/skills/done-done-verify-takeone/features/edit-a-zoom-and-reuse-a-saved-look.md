# Edit a zoom and reuse a saved look without keyframes

Part of the takeone verification map. Source: `src/refine.ts` (`takeone zoom`, `takeone look`), `src/cli.ts` (`render --look`), `src/render/edits.ts` (`validateZooms`).

## How to get to it (user POV)

A user refines a planned take from the shell: `takeone zoom <take> add <from-s> <to-s> <x,y,w,h> [--level 0-3]`,
`move <n> [--from S] [--to S] [--box x,y,w,h]`, `remove <n>` and `list` edit the take's `zooms` (source seconds,
source-pixel box); invalid edits are refused with the render's own message and leave `take.json` as it was.
`takeone look save <name> [--theme T] [--aspect A] [--set k=v]...` keeps a named look under `$XDG_CONFIG_HOME/takeone/looks.json`,
and `takeone render <take> --look <name>` applies it (options typed after `--look` win). GIF stays `--format gif`.

## Driving it

Harness: Shell (bash), ffmpeg/ffprobe, `fm-mem-gate.sh` for every capture and render. The real board scene is the proof, never a synthetic clip.

1. `npm run build`; `node scripts/headless-scene.mjs <dir>/board --aspect=landscape --no-title`; `scripts/verification/recorded-engine.sh "${TAKEONE_DIR:-tmp}/engine" node bin/takeone.mjs make <dir>/board --set fps=60`.
2. Copy the take twice (`zoomed`, `plain`), delete `text-boxes.json` from both (a push-in crops board text across the safe-area inset). Use a throwaway `XDG_CONFIG_HOME`.
3. `node bin/takeone.mjs zoom <dir>/zoomed add 26 31 2850,300,800,900` (Activity feed on the 3840x2160 board); `zoom list`; an overlapping `add 26 28 0,0,100,100` must exit 1 with `invalid zooms: overlapping intervals`.
4. `node bin/takeone.mjs look save launch --theme paper --aspect landscape --set accent=#c2410c`, then render both copies with `--look launch --preview` (default `max_upscale`: with `max_upscale=0.5` the zoom caps at 0.78x and proves nothing).
5. Look at stills at 28 s from both films: `plain` shows the whole board, `zoomed` the Activity feed filling the frame with readable text; also the frames at the arrival and the release. Note anything the render prints (`Camera upscale limit...`, `camera: N frames still cut text...`).
6. `takeone render <take> --look ghost` must exit 1 naming the saved looks.

The drive changes no repo file: note findings in the run's report.
