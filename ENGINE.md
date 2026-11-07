# Pinned Open Design

TakeOne uses a small, pinned slice of **Open Design**, from our maintained fork:
https://github.com/umeranjum17/open-design.

- Fork commit: `3805d0303285d019185cde25b110e5bba4f21140` (2026-10-29). It never tracks a branch.
- Upstream: https://github.com/nexu-io/open-design. The same commit exists there, so the fork and upstream match at this pin.
- Add-on branch: **none**. Vendored files are unmodified.
- Licence: Apache-2.0, retained verbatim at `vendor/open-design/LICENSE`. See [NOTICE](NOTICE).

`takeone doctor` prints the pin in its `open-design` row and fails that row if a vendored file no longer matches.

## Vendored

`vendor/open-design/manifest.json` records SHA-256 for every file.

| Path | Used by |
|---|---|
| `LICENSE` | The licence text for everything below |
| `skills/motion-design/references/replicate.md` | `takeone motion --reference <video> --measure` copies it beside the measurement as `REPLICATE.md` |

The rules file keeps its own text, including that project's `od media reference` and `od media compare` steps. TakeOne's equivalents:

```
takeone motion --reference <video> --measure [--out DIR]     measure a film into facts.json, frames/, contact.jpg
takeone motion <inputs...> --reference <video>               plan as usual, cut on that film's measured beats
takeone motion <inputs...> --reference <facts.json>          the same, reusing an earlier measurement
```

## Adapted, not copied

| Source at the pin | TakeOne file | What was taken |
|---|---|---|
| `plugins/_official/video-templates/frame-logo-outro/source/index.html` | `resources/motion/patterns/end-card.js` | Timing and sequence only: pieces arrive staggered from an offset at 1.4x with overshoot, then a glow, the name, and a sweep. TakeOne's own code, changed to run on its page clock and to split the customer's logo into its own shapes |

Read as formats, with no code copied: `brand.json`, DESIGN.md frontmatter and the `od-design-tokens/v1` file (`src/motion/brand.ts`). The measuring code in `src/motion/reference.ts` is TakeOne's own, written to the procedure in the rules file.

## Removed

Everything else in the fork is left out: its application, daemon, skills, plugins, templates and design-system catalogue. Three limits apply to anything taken later:

- **Licence:** only files verified as Apache-2.0 or MIT, carried with their licence text. Many folders have their own terms, and those take precedence over the root licence.
- **No Remotion:** nothing built on it, in any form.
- **No third-party brands:** no logos, marks or product names. Several templates show them on screen, and many catalogue entries imitate real brands.

GSAP in TakeOne is its own copy under its own terms (see [NOTICE](NOTICE)); the fork's inlined copies are not taken.

## Moving the pin

```
git clone https://github.com/umeranjum17/open-design.git <clone>
node scripts/sync-opendesign.mjs <clone> <40-char commit sha>
```

The script reads git blobs at that exact commit, refuses a branch name, rewrites the listed files and the manifest, and says when a source of adapted work changed. Then update this file and render the closing card again. The file list is the manifest's: taking a new file is a reviewed edit there, with its licence checked first.
