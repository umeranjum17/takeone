# Motion renders

`takeone motion design.png --out takes/launch --theme editorial --title "Ship your next idea" --device browser`

This mode turns saved screens into a film without recording. It runs offline after ingest, with a sha256 and version pinned Linux x86_64 headless shell. Install the shell with `takeone motion install-shell`; `takeone doctor` reports its identity.

The three core patterns are `hero-reveal`, `zoom-tour`, and `end-card`. A tour accepts `--region x,y,w,h:caption`; each stop reserves a bounded smooth move and enough reading time. Regions on different screens produce separate tours; impossible scene durations are rejected. `--state NAME='click #id; type #id "text"; wait 100'` captures real HTML or URL states. States run in order in one page; tuple operations in storyboard JSON also support partial drag `["drag", "#card", "#lane", {"capture_at":0.6}]` followed by `["drop"]`. Timer waits use a deterministic page clock while Chromium continues painting. No desktop or phone is involved.

`--plan-only` writes an editable storyboard. `takeone render <dir>` rerenders the saved storyboard and source screens. A supplied `--storyboard file.json` uses paths relative to the output take directory; use absolute source paths when importing a plan from elsewhere.

Storyboard v1 contains `source`, `screens`, `regions`, `scenes`, `output`, and `theme`. Scene `at` defaults to the previous scene end; scene windows define cuts. Text duration includes its reveal and a full reading hold. Output is 1920×1080 at 60 fps with eight fixed workers. Internal viewport dimensions support bento master comparisons. Worker count is part of the render identity: keep it fixed between deterministic rerenders. `render.json` records workers, shell, encoder, timing and subframe accumulation. Hero and tour bitmap transforms also write `camera.json`.

`layout: {kind:"bento", grid:"2x2", master:{d:6,scenes:[...]}, tiles:[{id:"TL",offset_s:0},...]}` plays the same master in four clipped viewports with shifted clocks. Tile ids are TL, TR, BL and BR. `pinwheel-3x2` instead takes `tiles:{A:[...],B:[...],C:[...],D:[...]}` for independent timelines. Gutters, page colour and corners are theme tokens.

`tempo:{bpm:120,phase_s:0,snap:"beat"}` requires scene boundaries on half-second beats. One frame of drift is snapped; larger drift is rejected. `snap:"half"` permits quarter-second boundaries.

Motion pages reject CSS gradients; use SVG gradients or patterns. Fonts are bundled with SHA entries and OFL licenses. Every displayed storyboard string passes a font cmap coverage gate. End-card glyphs use measured kerned positions. The fragment pattern accepts `kind`: button, input, chip, toast, feed-row, counter, line-chart, bar-chart, spinner, browser-chrome, phone-chrome; button states are idle/hover/pressed, input states empty/typing/filled.

Motion blur is enabled by default and accumulates subframes only above 35 output pixels per frame. The schedule uses eight samples normally and at least 24 around the fastest half-second, increasing sample count when needed to keep spacing within two pixels. `--blur 0` disables accumulation. Faster spans cost extra captures; the manifest reports the actual cost and peak spacing.

Offline proof gates compare the encode to lossless frames from the same render settings, require VMAF ≥95, and stop for human review if any frame has SSIM <0.95. They also check moving-camera duplicates and a rendered SVG smooth-ramp fixture for flat runs ≤64 pixels. The six-second timing proof fails above 15 seconds. Regenerate proofs after renderer changes.
