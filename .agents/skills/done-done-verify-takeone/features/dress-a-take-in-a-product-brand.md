# Dress a take in a product's brand

Part of the takeone verification map. Source: `src/motion/brand.ts` (`readBrand(file, "take")`, `fontNames`), `src/cli.ts` (`--brand` on `make` and `render`, `resolveCamera`), `src/render/render.ts` (`stagedFonts`, the render's one `fontsdir`), `src/make.ts`, `src/score/run.ts`, `test/brand-take.test.ts`, `scripts/verification/brand-take.sh`. Docs: `docs/look.md` ("A brand file dresses the film"), `docs/motion.md` (the same file on the glow recipe).

## How to get to it (user POV)

A project lead has a take of their app and a brand file (`brand.json` or a `DESIGN.md`) holding their palette and typeface. `takeone make <id> --brand brand.json` renders it in that palette; `takeone render <take> --brand brand.json` dresses an existing take the same way. Colours become the stage (`background`, `surface` → card, `foreground` → type, `border`, `accent`), and the display and body families come from a bundled family or from a font *file* the brand carries, which the render adds to its own font directory so the film is the same on a machine where that font is not installed. A family that is neither bundled nor carried is an error naming it, never a silent fallback to another face.

## Driving it

Harness: Shell (bash), a headless board capture, ffmpeg/ffprobe, `fm-mem-gate.sh` + the shared render slot for every capture, render and ffmpeg.

1. `bash scripts/verification/brand-take.sh <evidence-dir>` drives the whole proof (through the gate via `TAKEONE_RENDER_WRAP`, or as `done-done run brand-take`). It captures the staged board scene with one title and one caption, renders it with `takeone make --no-ai`, then renders the same take again with `--brand`, and decodes the same still from each film.
2. Look at the two stills side by side: the branded one sits on the brand's cream stage with a dark serif title and the band's caption in Manrope; the plain one is the midnight stage in Inter Bold. Nothing overlaps, no word is cut, and the title and caption sit in the band below the card.
3. Read `captions.ass` beside the take (the ASS the render wrote): `grep -o '\\fn[A-Za-z0-9 ]*' captions.ass` names every face the renderer set its text in — `Fraunces SemiBold` and `Manrope Medium` for this brand file, `Inter Bold` without it. That is the face actually applied, not the face requested.
4. The stage pixel at 6,6 of each still proves the palette: the midnight stage (`6 10 18`) without the brand, the brand background (`244 242 238`, the cream) with it. A light background is legitimate for a take; the glow recipe refuses one.
5. The refusal: a brand file naming a family TakeOne neither bundles nor carries (`"BrandSans"`) exits non-zero with `brand typography.display: "BrandSans" is not a font TakeOne bundles (no fallback is used); bundled families: ...` and writes no film. That is the expected result, not a failure of the drive.
6. Rerender the branded film with an explicit `--set background=#rrggbb` to see that a render-typed pair still wins over the brand file.

The drive changes no repo file: note findings in the run's report.
