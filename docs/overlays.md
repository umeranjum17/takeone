# Recording overlays

Rerender a take with `takeone render <take-dir>`. Shortcut actions derived from
`key.combo` automatically display keycaps in a frosted pill docked bottom-centre above the caption band.
Only a validated key name paired with Ctrl, Alt or Meta reaches the overlay;
Shift may accompany one of those modifiers. Bare keys, Shift-only typing, key
releases, typed text and malformed combinations produce no keycap. Each shortcut
holds for 2.2 output seconds, ending when the next starts.
The bevelled cells have a subtle shadow. Standard shortcuts have a `+` join;
`--set keycap_style=mac` uses ordered symbols such as ⌃⌥⇧⌘K without separators. A soft critical spring brings
them in; the last 250 ms fade out. Their size stays constant during camera motion.
The dock clears selected focus targets, spotlight and blur regions, and the measured
title/caption pills throughout the entire hold. If the dock is occupied, that keycap
is omitted. It never moves onto another part of the content.

Add timed source regions to `take.json`:

```json
{
  "spotlight": [{ "t": 1, "d": 3, "rect": [60, 150, 770, 210] }],
  "blur": [{ "t": 0, "d": 6, "rect": [890, 235, 290, 45] }]
}
```

`t` and `d` are video-relative seconds, before trim or idle squeezing. `rect` is
`[x, y, width, height]` in source pixels, with positive dimensions of at least two
pixels and entirely inside the source. Invalid regions fail the render with the
field and index. Region times follow the same trim and speed map as the footage.
Spotlights have rounded corners and feathered edges, inset from the source frame.
Their surroundings have a cool 38% dim and slight blur; the subject stays sharp.
Overlapping spotlights keep the union of their holes bright. Blur processes
only its selected source patch before camera transforms; it does not obscure the
rest of the frame. Choose a generous rectangle to cover the entire sensitive area.
Blur is a visual effect, not a guarantee of irreversible redaction.

Rebuild the ten-second fictional Tidewater board demo and before/after proof:

```sh
node scripts/synth-overlays.ts tmp/overlays
```

This requires `chrome-devtools-axi` and opens only the bundled `scripts/e2e/scene.html`
in its own headless browser session. It captures light and dark demo variants,
then writes `takeone-overlays-before.png`, `takeone-overlays-after.png`,
`takeone-overlays-after.mp4` and `takeone-overlays-before-after.mp4`.
The real output clip shows keycaps appearing and leaving on both variants.
No desktop or device capture is used.
