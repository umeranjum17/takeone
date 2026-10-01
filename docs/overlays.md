# Recording overlays

Rerender a take with `takeone render <take-dir>`. Shortcut actions derived from
`key.combo` automatically display separate keycap pills at the top of the output.
Only a validated key name with Ctrl, Alt or Meta reaches the overlay. Bare keys,
Shift-only typing, key releases, typed text and malformed combinations produce no
keycap. Each shortcut holds for 1.8 output seconds, ending when the next starts.
The keycaps stay at a readable size during camera motion and leave captions clear.

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
Overlapping spotlights keep the union of their rectangles bright. Blur processes
only its selected source patch before camera transforms; it does not obscure the
rest of the frame. Choose a generous rectangle to cover the entire sensitive area.
Blur is a visual effect, not a guarantee of irreversible redaction.

Rebuild the six-second fictional Umer demo and before/after proof:

```sh
node scripts/synth-overlays.ts tmp/overlays
```

This writes `takeone-overlays-before.png`, `takeone-overlays-after.png` and
`takeone-overlays-before-after.mp4`. No desktop or device capture is used.
