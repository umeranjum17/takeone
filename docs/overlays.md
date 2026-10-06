# Recording overlays

Rerender a take with `takeone render <take-dir>`. Shortcut actions derived from
`key.combo` automatically display keycaps in a frosted pill docked bottom-centre above the caption band.
Only a validated key name paired with Ctrl, Alt or Meta reaches the overlay;
Shift may accompany one of those modifiers. Bare keys, Shift-only typing, key
releases, typed text and malformed combinations produce no keycap. Each shortcut
holds for 2.2 output seconds, ending when the next starts.
The pill blurs the footage behind it and uses translucent fills, a subtle light inner
border and a soft shadow. Every key uses the bundled Inter SemiBold font. Standard shortcuts have a `+` join;
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

Toast windows in `take.json` (`"toasts": [{ "t": 4.2, "d": 2.2 }]`, same
video-relative seconds, no `rect`) move an overlapping caption up: on the overlay
path (any non-16:9 source or output) the caption pill would sit bottom-over-footage
where toasts live, so a caption sharing screen time with a toast takes the top slot
for its whole hold instead. The 16:9 band path is structurally disjoint from toasts
and ignores the windows. The producer observes the real toast and writes the window;
the renderer never guesses one from pixels.

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

The saved-take proof for this review is in
[`quality-evidence/t1-pm-12/52433a7e6f04b1d55ab61f63f79e95857aeacd8b`](quality-evidence/t1-pm-12/52433a7e6f04b1d55ab61f63f79e95857aeacd8b/).
It was rendered at that HEAD with working-tree changes; the
[provenance receipt](quality-evidence/t1-pm-12/52433a7e6f04b1d55ab61f63f79e95857aeacd8b/takeone-overlays-provenance.json)
binds the actual producer and source hashes, dirty patch, saved inputs, and output
hashes. It does not certify a later clean commit. Files labelled `pre-rebase`
retain their original bytes and receipt and are historical comparisons.

| Proof | Artifact |
| --- | --- |
| Light Ctrl+K | [Frame](quality-evidence/t1-pm-12/52433a7e6f04b1d55ab61f63f79e95857aeacd8b/takeone-overlays-after-light-ctrl-k.png) |
| Light Ctrl+S | [Frame](quality-evidence/t1-pm-12/52433a7e6f04b1d55ab61f63f79e95857aeacd8b/takeone-overlays-after-light-ctrl-s.png) |
| Dark Ctrl+K | [Frame](quality-evidence/t1-pm-12/52433a7e6f04b1d55ab61f63f79e95857aeacd8b/takeone-overlays-after-dark-ctrl-k.png) |
| Dark Ctrl+S | [Frame](quality-evidence/t1-pm-12/52433a7e6f04b1d55ab61f63f79e95857aeacd8b/takeone-overlays-after-dark-ctrl-s.png) |
| Mac modifier glyph fixture | [Mac keycaps](quality-evidence/t1-pm-12/52433a7e6f04b1d55ab61f63f79e95857aeacd8b/takeone-overlays-mac-keycaps.png) |
| Saved real take | [Strip](quality-evidence/t1-pm-12/52433a7e6f04b1d55ab61f63f79e95857aeacd8b/takeone-overlays-real-take-strip.png), [clip](quality-evidence/t1-pm-12/52433a7e6f04b1d55ab61f63f79e95857aeacd8b/takeone-overlays-after-ctrl-k-clip.mp4) |
| Same Ctrl+K before/after | [Still](quality-evidence/t1-pm-12/52433a7e6f04b1d55ab61f63f79e95857aeacd8b/takeone-overlays-before-after.png), [clip](quality-evidence/t1-pm-12/52433a7e6f04b1d55ab61f63f79e95857aeacd8b/takeone-overlays-before-after-ctrl-k.mp4) |
| Saved 38.3667–38.3833s camera regression | [Decoded diagnostic frame](quality-evidence/t1-pm-12/52433a7e6f04b1d55ab61f63f79e95857aeacd8b/takeone-overlays-rapid-pan.png), [clip](quality-evidence/t1-pm-12/52433a7e6f04b1d55ab61f63f79e95857aeacd8b/takeone-overlays-rapid-pan.mp4) |
| Caption-enabled crop boundary | [Decoded frame](quality-evidence/t1-pm-12/52433a7e6f04b1d55ab61f63f79e95857aeacd8b/takeone-overlays-caption-crop.png) |
| Static and ordinary motion | [Static frame](quality-evidence/t1-pm-12/52433a7e6f04b1d55ab61f63f79e95857aeacd8b/takeone-overlays-static.png), [ordinary pan](quality-evidence/t1-pm-12/52433a7e6f04b1d55ab61f63f79e95857aeacd8b/takeone-overlays-ordinary-pan.mp4) |

`node --test test/overlays.test.ts test/motion-blur.test.ts` runs the clipping
checks through decoded FFmpeg output, including the saved rapid camera path.
Set `TAKEONE_OVERLAY_EVIDENCE_DIR` to retain diagnostic frames and clips.
`node scripts/prove-overlays.ts <saved-input-dir> <evidence-dir>` reuses the saved
recording, trusted events, analysis, Mac background and historical proof, renders
with the native source, and writes the receipt. Diagnostic flat-source clips
isolate clipping; the real-take proof uses the approved saved recording without
new capture or AI analysis.
