---
name: verify-takeone
description: "Verify takeone — the local CLI that turns a screen capture into a polished demo MP4 (`make`, `render`, `motion`, `record`, `doctor`) — by driving its real commands and checking the real output files. Use whenever a takeone change needs proof, anything looks broken, or before claiming a render/pipeline feature works."
---

# Verify takeone

takeone is a short-lived local CLI (no server, no daemon). Verification means: build the checkout once, run the real `bin/takeone.mjs` commands the way the README teaches, and check the real artifacts they write (`out/<id>.mp4`, `camera.json`, `render.log`, `analysis/*`). A green exit code alone is not proof; the MP4 and its sidecar files are.

All paths below assume the repo root as working directory. `node bin/takeone.mjs` is the checkout-relative form; a linked install (`npm link`) exposes the same CLI as `takeone`.

## Launch

There is nothing to keep alive. Build once, then every drive is one foreground CLI invocation.

```sh
cd <takeone-checkout>
npm install        # runs prepare -> npm run build -> dist/ (skip if node_modules and dist/ already exist and are fresh)
npm run build      # rebuild after pulling; dist/ must be newer than src/
node bin/takeone.mjs --help   # readiness: exits 0 and prints the usage block
```

Prerequisites: Node ≥ 22.18 (`node --version`), `ffmpeg` and `ffprobe` on PATH. Optional: `tesseract` (only for `--screen-text` OCR), Hyprland/Wayland (only for desktop recording). Planning and rendering an existing take need none of the capture prerequisites.

In fleet/shared-machine contexts, every encode (`make`, `render`, `motion`, `scripts/synth-take.ts`) is heavy work: hold the assigned heavy render lock for the whole proof budget (normally this host's `/home/umer/.treehouse/firstmate-8bf1b0/1/firstmate/state/takeone-heavy.lock`). A reserved release slot requires explicit coordinator assignment; do not pick another lock opportunistically. Limit the stock CLI to eight allowed CPUs with `taskset -c <eight-allowed-CPU-IDs>` when needed; inspect current affinity first, never patch the renderer to get a slot.

## Doctor

One check before driving, or whenever anything looks off:

```sh
export TAKEONE_DIR="$PWD/tmp/verify-takes" TAKEONE_STATE_DIR="$PWD/tmp/verify-state"   # first: doctor creates the configured roots if missing
node bin/takeone.mjs doctor
```

Prints TOON `doctor[8]{check,ok,detail}` rows: `engine`, `engine-protocol`, `hyprland`, `evdev`, `ffmpeg`, `motion-shell`, `state-dir`, `takes-root`. The exit code is 0 only when every check passes, so read the `ok` column per check, not just the exit code: for make/render verification the gate is `ffmpeg,true` plus `takes-root,true`/`state-dir,true` — `hyprland`/`evdev`/`engine*` rows matter only for desktop recording, and `motion-shell,false` (pinned chrome-headless-shell missing) blocks only motion drives, where the fix is `takeone motion install-shell`.

## Drive

The harness is a plain shell driving the published CLI. No browser, no PTY needed. Assert on exit codes, the TOON stdout lines (`key[N]{…}`), and — for recorder errors — the structured JSON on stderr `{"error":{"code","message","hint"}}`.

Isolation rules for every drive:

- Point takes at scratch: `export TAKEONE_DIR="$PWD/tmp/verify-takes"` (default is the user's real `~/Videos/takeone`; never write there, and treat `takeone` bare-list output as the user's private data — do not read or share it).
- For record/stop drives also `export TAKEONE_STATE_DIR="$PWD/tmp/verify-state"` (default `~/.local/state/takeone`).
- Pass take directories as absolute paths so `make`/`render` never resolve through the real takes root.
- Never run `record` against a personal/shared desktop session; recording is for dedicated empty workspaces or test fixtures (see features/record-a-take.md). Never run `stop` unless this run owns the recording (it SIGINTs the pid in the state dir).

The canonical offline journey (works on any machine, zero capture, zero network, zero tokens):

```sh
export TAKEONE_DIR="$PWD/tmp/verify-takes" && mkdir -p "$TAKEONE_DIR"
node scripts/synth-take.ts "$TAKEONE_DIR/synth-demo"     # scripted 44 s 1920x1080 take, drawn by ffmpeg — no screen capture
node bin/takeone.mjs make "$TAKEONE_DIR/synth-demo" --no-jev   # local-only planning + render
test -s "$TAKEONE_DIR/synth-demo/out/synth-demo.mp4"     # the proof artifact
```

`make` rewrites `analysis/*`, `camera.json`, `camera.cmd` and `out/<id>.mp4` inside the take. `render <take-dir>` re-renders from the saved analysis without calling the planner (it prints the MP4 path on stdout). See `features/` for every mapped journey, real flags and per-feature gotchas.

### verify-takeone: preserved saved-take rerender

When capture or planning is not authorized, use `features/rerender-look-tweaks.md`
with an explicitly approved saved demo take. Inventory/hash every copied input,
verify the approved source hash, and copy only into task-local scratch. Preserve
`screen.webm`, `take.json`, `analysis/beats.json`, original `analysis/decisions.jsonl`
and any supplied events/metadata byte-for-byte. Drive `node bin/takeone.mjs render
<absolute-copy-path>`; don't run `make`, which replaces analysis and decisions.
Record whether saved beats were refreshed rather than original planner output.
Name the real typing/dialog/drag intervals and their limits; boundary hints are not
semantic whole-element annotations. Verify durable input hashes again afterward.

## Evidence

Name `verify-takeone` in each new proof recipe. Follow [CONSTRAINTS.md](../../../CONSTRAINTS.md)
for the Floor command, exit meanings and test-diet exception.
`.no-mistakes.yaml` links this skill through
published `test.instructions`, trusted-default-branch-only: pre-merge agent
consumption is unproven until a stock validator actually receives that runbook.

Proof artifacts live in a named folder inside the checkout, `tmp/evidence/verify-takeone-<YYYYMMDD-HHMMSS>/`, and must survive cleanup. This ignored folder keeps evidence outside the committed code branch. Per proof capture:

- The command lines run and their exit codes.
- The real output files the command produced: copy the rendered `out/<id>.mp4` into the evidence folder, plus a still extracted from it —
  `ffmpeg -y -ss <t> -i out/<id>.mp4 -frames:v 1 takeone-<feature>-<after>.png`
  (for a look/render change also extract the same timestamp from the pre-change render as `…-before.png`; stills are named `takeone-<feature>-<before|after>.png`).
- Machine-checkable output facts: `ffprobe -v error -show_entries format=duration,size -show_entries stream=width,height,codec_name -of json out/<id>.mp4 > probe.json`, and the sidecars (`camera.json`, `render.log`) that prove the pipeline ran.
- A manifest: `sha256sum * > SHA256SUMS` plus a line naming the producing commit (`git rev-parse HEAD`).

Standards: exercise the real user path (published CLI flags only — no internal setters, no test-only endpoints, no importing `dist/` internals as a library); capture the action and the resulting state, not just the final screen; verify side effects are files inside the take directory. `--no-jev` is a true offline mode (zero network calls); with a stored key `make` performs real paid calls — verification drives use `--no-jev` unless the point of the proof is the planner itself. A successful encode proves the pipeline and framing decisions ran; it does not qualify camera quality — visual quality claims need human review of the actual media. Label rendered defects `UNQUALIFIED`; missing prerequisites and incomplete validator/product proof must be reported as failure or inconclusive, never as release qualification.

## Cleanup

The CLI leaves no processes running (each invocation is foreground and exits). Cleanup removes only what this run created:

```sh
rm -rf "$PWD/tmp/verify-takes" "$PWD/tmp/verify-state"   # scratch takes/state this run made (never anything under ~/Videos/takeone)
```

Never delete: `tmp/evidence/` (proof evidence survives cleanup — verify after cleanup with `ls tmp/evidence/verify-takeone-*/`), committed evidence under `docs/evidence/` and `docs/quality-evidence/` (goldens), any take in the real takes root, or the portal token/state of a recording this run did not start. If this run started a recording it owns, end it with `takeone stop` before removing its scratch state dir.

## Keeping the map honest

Feature changes should update `features/` in the same change. For ongoing maintenance of this skill, follow the installed `maintain-verification-skill` skill rather than adding automation here.
