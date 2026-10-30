# Pick one of three directions and polish it to 9/10 on the board

Part of the takeone verification map. Source: `src/directions/directions.ts`, `src/directions/run.ts`, `src/polish/loop.ts`, `src/polish/builder.ts`, `src/polish/run.ts`, `src/board/board.ts`, `src/board/page.ts`, `src/score/judge.ts`, `src/cli.ts`, `test/directions.test.ts`, `docs/directions.md`. Full recipe and gotchas: `docs/directions.md`.

## How to get to it (user POV)

After recording a take, the user runs `takeone directions <take> --count 3 --board <decisions.json>`: one planner call proposes three directions (theme, pacing, camera motion), each is rendered in full from the same plan, the judge scores each once, and one design card with three playable options lands on the sign-off board. The owner picks on the board (or `takeone pick <take> b`), optionally with a note. `takeone polish <take> --board <decisions.json>` then renders the picked cut again as round 0, judges it, and refines it round by round (measured changes, then one builder call) until the judge gives 9/10 with every note met, two rounds pass without a better score, or five refinements are spent. Every round lands on the board as a playable option with its score; notes left on the board become feedback for the next round.

## Driving it

Harness: Shell (bash), ffmpeg/ffprobe, a sign-off board the run owns, chrome-devtools-axi for the board at 390 and 1280 px, and `fm-mem-gate.sh` plus the render slot around every render and ffmpeg command.

1. Capture the real Tidewater board take: `node scripts/headless-scene.mjs <scratch>/tidewater`. Make a board the run owns: `sign-off-axi init` in a scratch folder (change its port when 4410 is taken), never the owner's own board.
2. `TAKEONE_SIGN_OFF=<sign-off cli> node src/cli.ts directions <scratch>/tidewater --count 3 --goal "<sentence>" --board <board>/.sign-off/decisions.json`. Needs the signed-in planner and the judge (`claude` CLI); exit 3 when either cannot serve. Read `directions/directions.json`: three directions with distinct themes, three real MP4s, a score each and `calls.judge` 3.
3. Answer the card on the board (pick a letter, add a note) or run `takeone pick <take> <letter>`. `take.json` must carry `direction`; `takeone pick <take>` with no letter reads the board answer.
4. `node src/cli.ts polish <take> --board <decisions.json>`. Read `polish/<n>/run.json`: round 0 is the picked cut, every round has a score, `accepted`, the feedback checks with reasons and the changes; the stop reason is one of `target_reached`, `no_improvement_two_rounds`, `round_cap`, `no_change_left`. A run below 9 prints `BELOW TARGET` and is still exit 0.
5. Look at the films, not only the scores: decode stills during a camera move and at the final shot from round 0 and the final round, and a contact sheet across the three directions. The final film is `out/<id>.mp4`.
6. Open the board at 390 and 1280 px wide: the directions card and the latest polish card are under Designs; open an option full screen and play its video in place; the score shows beside it. Earlier round cards are archived as replaced.
Gotchas: the default Claude CLI judge is text-only, so it scores the facts measured from the three sampled frames rather than the pixels; an image-capable `judge.json` route sees the three frames blurred. The board serves a file beside a page up to 5 MB, so check the board copies under `mocks/<key>/` stayed under it. A re-run of `directions` archives the earlier directions card before posting.

7. Capture to the run folder: `takeone-directions-after.mp4` (the final polished film), `takeone-directions-contact-sheet.png`, `takeone-directions-board-phone.png`, `takeone-directions-board-desktop.png`, `directions.json`, `run.json`, the terminal transcript, ffprobe JSON and hashes.

The drive changes no repo file: note findings in the run's report.
