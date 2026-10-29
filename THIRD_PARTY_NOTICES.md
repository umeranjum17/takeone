# Third-party notices

Fonts carry their own OFL notices in `resources/fonts/manifest.json`. This file covers code and text adapted from other projects.

## motion-video-kit

https://github.com/echris6/motion-video-kit, commit 255562b. Copyright (c) 2026 echris6. MIT License.

Adapted, not vendored: the frozen-time metric (YDIF < 0.35 on 10 fps, 320 px grey samples), its pacing numbers
(no motionless stretch over 0.6 s, at most 1 s frozen per 30 s) and the ebur128 loudness recipe, re-implemented
in `src/motion/gates.ts`.

> MIT License
>
> Copyright (c) 2026 echris6
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction, including without limitation
> the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
> to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of
> the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
> THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
> CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
> DEALINGS IN THE SOFTWARE.

## GSAP

https://gsap.com, version 3.13.0. Copyright 2025, GreenSock. Used under GreenSock's "Standard No Charge" licence, https://gsap.com/standard-license.

Vendored unmodified as `resources/motion/vendor/gsap.min.js` (its licence header kept) and inlined into every HyperFrames
motion project. The no-charge terms apply only while end users are not charged a fee to use the product the library ships in.

## Brand file shape

The brand reader in `src/motion/brand.ts` follows the published `brand.json` and DESIGN.md frontmatter shape of
https://github.com/nexu-io/open-design (Apache License 2.0): the colour roles (background, surface, foreground, muted, border,
accent, accent-secondary), the display, body and mono typography families and the logo path. Format reference only: no upstream
file or code is copied or vendored, so no upstream licence text is bundled.
