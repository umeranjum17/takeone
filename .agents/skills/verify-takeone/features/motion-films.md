# Motion films from screens (`motion`)

Turn saved screens (images, HTML, or a URL) into a motion-design film without recording anything. `takeone motion` ingests the sources through a pinned headless shell, plans a storyboard (`hero-reveal`, `zoom-tour`, `end-card`), and renders an MP4 take offline.

## Sub-features

- Pattern planning: `--pattern hero-reveal,zoom-tour,end-card` (all three when omitted); zoom-tour stops via `--region x,y,w,h[:caption][@SCREEN]`.
- Interactive page states: `--state NAME='click #id; type #id "text"; wait 100'` captures real HTML/URL states in one page, in order.
- Copy chrome: `--title`, `--subtitle`, `--cta`, `--url`, `--logo`, `--device browser|phone|laptop|none`; theme tokens as elsewhere.
- Storyboard workflow: `--plan-only` writes an editable `storyboard.json` without ingest/render; `--storyboard file.json` renders a plan; `takeone render <dir>` rerenders the saved storyboard (motion takes reject `--theme`/`--set`).
- Shell management: `takeone motion install-shell` fetches the sha256-pinned Linux x86_64 headless shell (needs network + `unzip`, once); `takeone doctor` reports its identity; `TAKEONE_CHROME` selects an existing matching shell.

## How to get to it (user POV)

The user has screenshots or an HTML page and wants a launch film: `takeone motion design.png --out takes/launch --theme editorial --title "Ship your next idea" --device browser`. The result is a take-shaped directory (`take.json`, `sources/`, `storyboard.json`, `out/<id>.mp4`, `render.json`) that `takeone list` shows and `takeone render` rerenders.

## Driving it with the takeone CLI

```sh
node bin/takeone.mjs motion install-shell                      # once per machine; verify via doctor afterwards
export TAKEONE_DIR="$PWD/tmp/verify-takes"
node bin/takeone.mjs motion /abs/design.png --out "$TAKEONE_DIR/verify-motion" \
  --pattern end-card --title "Ship your next idea" --device browser; echo "exit=$?"
```

Proving end state: exit 0; the output take dir contains `storyboard.json`, `sources/`, `render.json` (workers, shell, encoder, timing) and `out/<id>.mp4` that `ffprobe` reports as 1920×1080 (default). `--plan-only` alone proves planning only — it writes no MP4, so it is not render proof.

## Gotchas

- The first render needs the pinned headless shell installed (`install-shell`, network once); afterwards everything is offline. `doctor` reports the shell identity — check it before blaming the renderer.
- Motion pages reject CSS gradients (use SVG gradients/patterns) and enforce font glyph coverage: a rejected plan names the missing glyph; that is by design.
- Worker count is part of the render identity — keep `--workers` fixed between deterministic rerenders.
- Rerendering a motion take takes no options: edit `storyboard.json` instead; `render <motion-dir> --set …` is an error.
- Ingest and encode are heavy — hold the shared heavy lock in fleet contexts.
