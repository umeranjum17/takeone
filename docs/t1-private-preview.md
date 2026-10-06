# Private tester build (main e451778)

A private tester build is frozen from this commit for hands-on testing. It is a
tester build, not a qualified-stable promise. The immutable archives live outside
this public repo (private handoff only); nothing below contains media or hashes.

## What a tester can do with it

Record the screen the way the app is normally used, let takeone plan every zoom,
hold, and pan from what actually happened (AI-assisted for a fraction of a cent
per minute, or fully offline with `--no-jev`), and get a framed, paced, captioned
1080p60 MP4 rendered locally. Saved screens or a page can also become a
motion-design launch film, in six themes. It is a command-line studio: terminal
in, MP4 out.

## Known limits

- Proven for this build: dependency install from the pinned lockfile and
  command-line entry (`--help`, planner/renderer imports, version metadata).
- Not proven: desktop recording journeys, phone or tablet journeys (the
  Android/iOS adapters are CLI integrations, not shipped apps), fresh renders,
  and the full test matrix. Linux + Node >= 22 + ffmpeg host scope.
- README honesty note: every capture is from the fresh proof take except the
  overflow-menu close-up (previous proof take) and the captions illustration
  (a synthetic take), as the README states next to the images.

## How a tester gets it

Private handoff of the runtime archive: extract, `npm ci`, then
`node bin/takeone.mjs --help` (needs Node >= 22 and ffmpeg). Ask the maintainer;
it is never published, tagged, or attached to this repo.
