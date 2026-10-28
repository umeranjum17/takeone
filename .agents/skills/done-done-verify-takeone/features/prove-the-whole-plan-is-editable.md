# Prove the whole approved plan is editable and unsupported edits are refused

Part of the takeone verification map. Source: `src/decide/plan.ts` (readPlan, writePlan, validatePlan,
applyPlan, withUserFilm), `src/make.ts` (film merge, writePlan call), `src/render/render.ts`, `src/cli.ts`
(resolveCamera).

## How to get to it (user POV)

`takeone make <id>` writes `analysis/plan.json` with, per beat, `shot`, `idle`, `follow`, `focus_start`,
`focus_end`, `tightness`, `key_moment` and, under `film`, `theme`, `pace`, `opening`, `camera_style`, `ending`
(a beat key) and `title`. Set a `value` and `"by": "user"`, then `takeone render <id>` (or `make` again).

## Driving it

Harness: Shell, ffmpeg/ffprobe, every render through `fm-mem-gate.sh` + `render-slot.sh`. Use the real board
scene take (`node scripts/headless-scene.mjs <dir>`), `make --no-ai`, run `npm run build` first (bin runs dist/).

1. Edit `tightness` on a click or type beat (not a travel, scroll or cut beat) and `film.opening`; `render`.
   Assert `camera.json` differs from the baseline from the opening onward and at the edited beat.
2. Refusals, each exit non-zero naming the beat or field: tightness on a travel beat; `focus_start` that is
   not a zone of the beat; an unknown field (`merge_prev`, `film.captions`); `film.title` when `take.json`
   has its own title (the board scene does); `--set pace=` together with `film.pace`.
3. Cut a still from both films at the edited beats and put them side by side. Look at it.
The fixture test `test/make.test.ts` "the whole plan is editable" runs every refusal and one valid edit.
