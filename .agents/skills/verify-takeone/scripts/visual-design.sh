#!/usr/bin/env bash
# verify-takeone design check: judge every cell still of a visual pass with done-done design.
# A required step of the visual defect pass: visual-pass.sh runs this after its own checks.
# Exit 0 when every screen passes, 1 when a screen fails, 3 when none fails but one is
# unsure (a human look), 2 on usage or setup error. Both 1 and 3 fail the visual pass.
#
#   visual-design.sh <out-dir> [--ref <main-pass-dir>] [--motion-mock <contact.png>]... [--prefix <dir>] [--resume]
#
# Screens are the held screens inside the cell stills: each still is cropped to the shown
# rect its own check records (`<cell>.json` facts.shown), so the judge sees the screen, not
# the stage matte around it (a staged frame without a mock fails the pixel strip measure on
# the matte). The mock is cropped with the same rect. Mocks come from the reference pass's
# film at the same moment (`--ref <cell>.mp4`, extracted to `<cell>-t<time>-mock.png`); when
# the branch film runs past the reference there is no same moment, so that still is judged
# alone and the gap is logged (an alone screen can fail on intended UI such as a dialog, so
# the reference pass must render every cell film in full). `--motion-mock` (repeatable:
# first for motion-dark, second for motion-light) overrides the motion mocks with approved
# contact sheets. A mock must show the screen's own approved design: a live probe showed a
# motion still judged next to a contact sheet of other content fails with a bogus `layout`
# defect, so the `--motion-ref` side-sheet contacts are never passed as design mocks.
# Without geometry or a mock a screen is judged alone (full frame).
#
# Judging runs one done-done call per cell (at most a few screens each), not one call for
# the whole pass: a 60-screen call dies with the session that started it and loses every
# verdict, while per-cell calls append each cell's verdicts to design.log and pass.log as
# they land, keep per-cell `design.<cell>.json` files, and aggregate `design.json` at the
# end. `--resume` reuses a cell file from an earlier run instead of re-judging it.
#
# An `unsure` whose reason shows the judge never answered (a transport failure such as
# `did not answer`, `ETIMEDOUT`, or invalid JSON, never a genuine "not confident enough")
# is retried, up to 3 attempts per screen; a screen unsure after that stays unsure and
# fails the pass with a human-look note.
#
# done-done is not published to npm, so this installs the pinned commit into a private prefix
# (never `npm install -g`, never the repo's package.json). The default prefix is
# ~/.cache/takeone-visual-done-done (override with --prefix or DONE_DONE_PREFIX); a marker file
# records the installed pin and a mismatch reinstalls. The judge runs on Command Code
# DeepSeek v4.1 Flash through BYOKit as done-done configures it (route answerer:pi, model
# commandcode/deepseek/deepseek-v4.1-flash, written to a scratch DONE_DONE_HOME inside <out-dir>
# so no key is needed, none is printed, and the machine's ~/.done-done is untouched; the
# machine's existing pi login is used as is).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); repo=$(cd "$here/../../../.." && pwd)
PIN=6b529b61135000d9fd610ca2c744287b0d1f87e2
MODEL=commandcode/deepseek/deepseek-v4.1-flash
out=; ref=; resume=; prefix=${DONE_DONE_PREFIX:-$HOME/.cache/takeone-visual-done-done}
mmocks=()
while [ $# -gt 0 ]; do
  case $1 in
    --ref) ref=$(cd "$2" && pwd); shift 2;;
    --motion-mock) mmocks+=("$2"); shift 2;;
    --prefix) prefix=$2; shift 2;;
    --resume) resume=1; shift;;
    -*) echo "visual-design: unknown option $1" >&2; exit 2;;
    *) out=$1; shift;;
  esac
done
[ -n "$out" ] || { echo "visual-design: missing <out-dir>" >&2; exit 2; }
mkdir -p "$out"; out=$(cd "$out" && pwd)
log=$out/design.log; [ -n "$resume" ] || : > "$log"
say() { echo "$*" | tee -a "$log"; }

# Cell stills only: <cell>-t<seconds>.png for a cell with a <cell>.mp4 in the same dir.
# Side sheets (-side), expected pictures (-expected), defect crops (<base>-<check>-<n>) and
# stray stills (negative-control inputs share the folder) never match.
stills=(); all=()
while IFS= read -r f; do all+=("$f"); done < <(ls "$out"/*.png 2>/dev/null | grep -E '\-t[0-9]+\.[0-9]+\.png$' | sort || true)
for f in ${all[@]+"${all[@]}"}; do
  base=$(basename "$f" .png); ts=${base##*-t}; cell=${base%-t$ts}
  if [ -s "$out/$cell.mp4" ]; then stills+=("$f"); else say "visual-design: skipping $base (no $cell.mp4)"; fi
done
[ "${#stills[@]}" -gt 0 ] || { say "visual-design: no cell stills in $out"; exit 2; }

# Private done-done install at the pinned commit.
bin=$prefix/node_modules/.bin/done-done
if [ ! -x "$bin" ] || [ "$(cat "$prefix/.done-done-pin" 2>/dev/null || true)" != "$PIN" ]; then
  say "visual-design: installing done-done@$PIN into $prefix"
  npm install --prefix "$prefix" --allow-git=all "github:umeranjum17/done-done-axi#$PIN" '@byokit/decide@0.8.0' >> "$log" 2>&1 || { say "visual-design: install failed"; exit 2; }
  echo "$PIN" > "$prefix/.done-done-pin"
fi
[ -x "$bin" ] || { say "visual-design: $bin not executable after install"; exit 2; }

# Scratch judge home: explicit route and model, no keys, machine config untouched.
ddhome=$out/dd-home; mkdir -p "$ddhome"
printf 'judge:\n  route: answerer:pi\n  model: %s\n' "$MODEL" > "$ddhome/config.yaml"

declare -A mock_of
screens=()
crop_of() { # <cell> <base>: the held screen's rect as w:h:x:y, or nothing when unknown
  node -e '
const j = require(process.argv[1]), want = process.argv[2] + ".png";
const r = (j.results || []).find(r => r.still === want), s = r && r.facts && r.facts.shown;
if (!s || !(s.w > 4 && s.h > 4)) process.exit(1);
console.log([s.w, s.h, s.x, s.y].map(v => Math.max(0, Math.round(v))).join(":"));' \
    "$out/$1.json" "$2" 2>/dev/null
}
for s in "${stills[@]}"; do
  base=$(basename "$s" .png); ts=${base##*-t}; cell=${base%-t$ts}
  mock=; refmock=0
  if [ "$cell" = motion-dark ] && [ "${#mmocks[@]}" -ge 1 ]; then mock=${mmocks[0]}
  elif [ "$cell" = motion-light ] && [ "${#mmocks[@]}" -ge 2 ]; then mock=${mmocks[1]}
  elif [ -n "$ref" ] && [ -s "$ref/$cell.mp4" ]; then
    mock=$out/$base-mock.png; refmock=1
    if ! ffmpeg -nostdin -v error -y -threads 2 -filter_threads 2 -filter_complex_threads 2 \
      -ss "$ts" -i "$ref/$cell.mp4" -frames:v 1 -update 1 "$mock" >> "$log" 2>&1 || [ ! -s "$mock" ]; then
      # The branch film runs past the reference (fresh fixtures beat differently): no same
      # moment exists, so the still is judged alone and the gap is logged, not faked.
      say "visual-design: no ref frame for $base at ${ts}s, judging alone"
      mock=
    fi
  fi
  # Judge the held screen, not the stage matte: crop still and mock to this cell's own
  # geometry. Without geometry the full frame is judged and the fallback is logged.
  img=$s; mmock=$mock; crop=$(crop_of "$cell" "$base" || true)
  if [ -n "$crop" ]; then
    img=$out/$base-screen.png
    if ! ffmpeg -nostdin -v error -y -threads 2 -filter_threads 2 -filter_complex_threads 2 \
      -i "$s" -vf "crop=$crop" -frames:v 1 -update 1 "$img" >> "$log" 2>&1 || [ ! -s "$img" ]; then
      say "visual-design: crop $crop failed for $base, judging full frame"; img=$s; mmock=$mock
    elif [ -n "$mock" ] && [ "$refmock" = 1 ]; then
      mmock=$out/$base-mock-screen.png
      if ! ffmpeg -nostdin -v error -y -threads 2 -filter_threads 2 -filter_complex_threads 2 \
        -i "$mock" -vf "crop=$crop" -frames:v 1 -update 1 "$mmock" >> "$log" 2>&1 || [ ! -s "$mmock" ]; then
        say "visual-design: mock crop $crop failed for $base, judging screen alone"; mmock=
      fi
    fi
  else say "visual-design: no screen geometry for $base, judging full frame"; fi
  screens+=("$img")
  if [ -n "$mmock" ] && [ -s "$mmock" ]; then
    mock_of["$img"]=$mmock
  elif [ -n "$mmock" ]; then
    say "visual-design: mock missing for $base: $mmock"; exit 2
  fi
done

cell_of() { # <screen img path>: the pass cell it belongs to
  local b; b=$(basename "$1" .png); b=${b%-screen}
  echo "${b%-t${b##*-t}}"
}

judge_cell() { # <cell> <cell-json> <screen...>: one done-done call, retrying transport-error unsures
  local cell=$1 json=$2; shift 2
  local imgs=("$@") args=() img
  for img in "${imgs[@]}"; do
    args+=("$img")
    [ -n "${mock_of["$img"]:-}" ] && args+=(--mock "$img=${mock_of["$img"]}")
  done
  local attempt=0 retry=("$@") tmp=$json.tmp
  while :; do
    local rc=0
    DONE_DONE_HOME=$ddhome "$bin" design --json --full "${args[@]}" > "$tmp" 2> "$out/design.$cell.err" || rc=$?
    case $rc in 0|1|3) :;; *) say "visual-design: done-done exited $rc for $cell"; cat "$out/design.$cell.err" >> "$log"; return 2;; esac
    [ "$attempt" = 0 ] && cp "$tmp" "$json" || node -e '
      const fs = require("fs"), cur = JSON.parse(fs.readFileSync(process.argv[2], "utf8")),
        nxt = JSON.parse(fs.readFileSync(process.argv[3], "utf8")),
        byPath = Object.fromEntries(nxt.screens.map(s => [s.path, s]));
      cur.screens = cur.screens.map(s => byPath[s.path] ?? s);
      cur.counts = { pass: 0, fail: 0, unsure: 0 };
      for (const s of cur.screens) cur.counts[s.verdict === "fail" ? "fail" : s.verdict === "unsure" ? "unsure" : "pass"]++;
      cur.result = cur.counts.fail ? "fail" : cur.counts.unsure ? "unsure" : "pass";
      fs.writeFileSync(process.argv[2], JSON.stringify(cur, null, 2) + "\n");' _ "$json" "$tmp"
    # An unsure whose reason shows the judge never answered is a transport failure, not a
    # verdict: re-judge just those screens, up to 3 attempts each.
    mapfile -t retry < <(node -e '
      const r = require(process.argv[1]);
      for (const s of r.screens ?? [])
        if (s.verdict === "unsure" && /did not answer|ETIMEDOUT|valid JSON|timed out|ECONN|EPIPE|exited [1-9]|spawnSync/i.test(s.reason ?? ""))
          console.log(s.path);' "$json")
    [ "${#retry[@]}" = 0 ] || [ "$attempt" -ge 2 ] && break
    attempt=$((attempt + 1))
    say "visual-design: retrying ${#retry[@]} unanswered screen(s) in $cell (attempt $((attempt + 1))/3)"
    args=(); for img in "${retry[@]}"; do
      args+=("$img")
      [ -n "${mock_of["$img"]:-}" ] && args+=(--mock "$img=${mock_of["$img"]}")
    done
  done
  rm -f "$tmp"
}

cells=(); declare -A seen
for img in "${screens[@]}"; do c=$(cell_of "$img"); [ -n "${seen[$c]:-}" ] || { cells+=("$c"); seen[$c]=1; }; done
withmocks=0; for img in "${screens[@]}"; do [ -n "${mock_of["$img"]:-}" ] && withmocks=$((withmocks + 1)); done
say "visual-design: done-done@$PIN design on ${#screens[@]} stills ($withmocks with mocks) in ${#cells[@]} cell calls, judge answerer:pi $MODEL"

have_fail=0; have_unsure=0
for c in "${cells[@]}"; do
  cimgs=(); for img in "${screens[@]}"; do [ "$(cell_of "$img")" = "$c" ] && cimgs+=("$img"); done
  if [ -n "$resume" ] && [ -s "$out/design.$c.json" ]; then
    say "visual-design: reusing $c verdicts from design.$c.json (--resume)"
  else
    judge_cell "$c" "$out/design.$c.json" "${cimgs[@]}" || { say "visual-design: setup error judging $c"; exit 2; }
  fi
  node -e '
const r = require(process.argv[1]);
for (const s of r.screens ?? []) {
  const d = (s.defects ?? []).map(x => `${x.kind}@${x.where}`).join(" | ");
  console.log(`design ${s.verdict} ${s.path}${s.mock ? ` mock=${s.mock}` : ""}${d ? ` ${d}` : ""}${s.reason ? ` reason=${s.reason}` : ""}`);
}
console.log(`design counts pass=${r.counts?.pass ?? 0} fail=${r.counts?.fail ?? 0} unsure=${r.counts?.unsure ?? 0} result=${r.result} judge=${r.judge?.route} ${r.judge?.model} independence=${r.judge?.independence}`);
' "$out/design.$c.json" | tee -a "$log" >> "$out/pass.log"
  case $(node -e 'console.log(require(process.argv[1]).result)' "$out/design.$c.json") in
    pass) say "DESIGN-PASS design $c: every screen passed";;
    fail) say "DESIGN-FAIL design $c: a screen failed, see design.$c.json"; have_fail=1;;
    *) say "DESIGN-FAIL design $c: a screen is unsure, needs a human look: $(node -e 'for (const s of require(process.argv[1]).screens ?? []) if (s.verdict === "unsure") console.log(s.path)' "$out/design.$c.json")"; have_unsure=1;;
  esac
done

cd "$repo"
node -e '
const fs = require("fs"), files = process.argv.slice(2);
const first = JSON.parse(fs.readFileSync(files[0], "utf8"));
const screens = [], counts = { pass: 0, fail: 0, unsure: 0 };
for (const f of files) for (const s of JSON.parse(fs.readFileSync(f, "utf8")).screens ?? []) {
  screens.push(s); counts[s.verdict === "fail" ? "fail" : s.verdict === "unsure" ? "unsure" : "pass"]++;
}
fs.writeFileSync(process.argv[1], JSON.stringify({ command: "design",
  result: counts.fail ? "fail" : counts.unsure ? "unsure" : "pass",
  judge: first.judge, counts, screens }, null, 2) + "\n");' \
  "$out/design.json" $(for c in "${cells[@]}"; do echo "$out/design.$c.json"; done)

{ echo; echo "## Design check (done-done design @$PIN, judge answerer:pi $MODEL)"; echo
  echo "| screen | verdict | mock | defects |"; echo "|---|---|---|---|"
  node -e '
const r = require(process.argv[1]);
for (const s of r.screens ?? []) {
  const b = s.path.split("/").pop(), m = (s.mock ?? "").split("/").pop();
  const d = (s.defects ?? []).map(x => `${x.kind}: ${x.where}`).join("<br>") || (s.reason ?? "");
  console.log(`| ${b} | ${s.verdict} | ${m} | ${d} |`);
} console.log("", `Result: ${r.result} (exit codes: 0 pass, 1 fail, 3 unsure; both fail the visual pass). Full output: design.json, design.log.`);' "$out/design.json"; } >> "$out/index.md"

rc=0; [ "$have_fail" = 1 ] && rc=1; [ "$have_fail" = 0 ] && [ "$have_unsure" = 1 ] && rc=3
case $rc in
  0) say "DESIGN-PASS design: every screen passed";;
  1) say "DESIGN-FAIL design: a screen failed, see design.json";;
  3) say "DESIGN-FAIL design: no fail but a screen is unsure, needs a human look";;
esac
exit "$rc"
