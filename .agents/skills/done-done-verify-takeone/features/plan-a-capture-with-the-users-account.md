# Plan a capture with the user's account

Part of the takeone verification map. Source: `src/capture.ts`, `src/make.ts`, `scripts/verification/capture-planner-account-live.sh` (the same plan through an API-key route held in a throwaway HOME; `DRY=1` stops before any provider call).

## How to get to it (user POV)

A host app (a program that calls `takeone capture`) has no planner key of its own, and the
user's only AI access is the signed-in subscription on this machine. The host passes
`--planner-account` to say it allows takeone to plan with that account; the account is
resolved exactly as `takeone make` resolves it. Without the flag capture keeps its
host-owned credential contract and plans with local rules.

## Driving it

Harness: Shell (bash), with ffmpeg and ffprobe to decode frames.

1. Node scripts/synth-take.ts "$PWD/tmp/verify-cap-account" to make a real take, then
   `TAKEONE_DIR="$PWD/tmp/verify-takes" TAKEONE_STATE_DIR="$PWD/tmp/verify-state"
   node bin/takeone.mjs capture make "$PWD/tmp/verify-cap-account" --planner-account`.
   Run it with the normal HOME: the product uses the user's installed, already signed-in
   CLI account as it is, exactly as `takeone doctor` and `takeone make` do. Never copy or
   read that sign-in.
2. Check the proof, not the exit code: stdout is one JSON object whose `planner.input_tokens`
   is above zero and whose `warnings` hold no "no planner key" or fallback-rules line; stderr
   carries `AI planner: signed-in <provider> account`; `take.json` records
   `planner.mode: "ai"`; and `out/<id>.mp4` exists with a readable video stream.
3. The three states to drive: with the flag and a signed-in account (above); with the flag and
   no account (isolated HOME, PATH holding only ffmpeg, no stored key) capture exits 1 with
   `error.code: "planner-unavailable"`, a message naming the cause, and no `out/` directory —
   never a silent local-rules film; and without the flag (default) capture plans locally even
   when an account is signed in, warning "no planner key; using heuristic policy for all beats".
4. Capture: one still decoded from the planned MP4 at 5 s to
   $DONE_DONE_EVIDENCE_ROOT/takeone-capture-account-after.png, the JSON object and the stderr
   line to $DONE_DONE_EVIDENCE_ROOT/takeone-capture-account-after.txt, and the ffprobe output
   to $DONE_DONE_EVIDENCE_ROOT/takeone-capture-account-after.json.
5. Stop what you started; the takes and state go under tmp/ as SKILL.md's Isolation section says.

The drive changes no repo file: note findings in the run's report; after the drive, run done-done maintain to see what drifted, then fix the skill.