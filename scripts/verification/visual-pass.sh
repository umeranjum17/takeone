#!/usr/bin/env bash
# done-done visual defect pass: render the canonical offline takes from this checkout and check
# every cell with visual-check.ts. Exit 1 when any cell shows a defect. See README.md.
#
#   visual-pass.sh <out-dir> [--ref <main-pass-dir>] [--motion-ref <contact.png>]... [--cells "<cell> ..."] [--work <dir>] [--check-only] [--no-design]
#
# --check-only reuses the cell takes already rendered in --work and only re-runs the checks.
# --no-design skips the done-done design step: reference passes run with it (their stills
# have no reference film to take mocks from, so every screen would judge alone).
#
# Cells (10): desktop-{dark,light} (synth-take.ts, 1920x1080), portrait-{dark,light} (synth-portrait.ts,
# 1080x1920), 45-{dark,light} (synth-portrait.ts --aspect 4:5), font-{dark,light} (synth-phone-font.ts,
# Android largest font, 1080x1920), motion-{dark,light} (motion --device phone of the font board).
# Dark is midnight, light is paper. <out-dir> gets <cell>.mp4, stills, <cell>-t<time>-side.png sheets
# (the still next to --ref's film at the same moment, or the motion contact sheets), defect crops,
# <cell>.json, pass.log and index.md, all flat. Set TAKEONE_GATE to a command prefix (a memory gate)
# for every render and check; make always runs --no-jev in an isolated TAKEONE_DIR/TAKEONE_STATE_DIR.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); repo=$(cd "$here/../.." && pwd)
out=; ref=; work=; only=; nodesign=; cells="desktop-dark desktop-light portrait-dark portrait-light 45-dark 45-light font-dark font-light motion-dark motion-light"
mrefs=()
while [ $# -gt 0 ]; do
  case $1 in
    --ref) ref=$(cd "$2" && pwd); shift 2;;
    --motion-ref) mrefs+=(--ref "$2"); shift 2;;
    --cells) cells=$2; shift 2;;
    --work) work=$2; shift 2;;
    --check-only) only=1; shift;;
    --no-design) nodesign=1; shift;;
    -*) echo "visual-pass: unknown option $1" >&2; exit 2;;
    *) out=$1; shift;;
  esac
done
[ -n "$out" ] || { sed -n '5p' "$0" >&2; exit 2; }
mkdir -p "$out"; out=$(cd "$out" && pwd)
work=${work:-$out/work}
export TAKEONE_DIR="$work/takes" TAKEONE_STATE_DIR="$work/state"
mkdir -p "$TAKEONE_DIR" "$TAKEONE_STATE_DIR"
read -r -a gate <<< "${TAKEONE_GATE:-}"
run() { "${gate[@]}" "$@"; }
cd "$repo"
log=$out/pass.log; : > "$log"
say() { echo "$*" | tee -a "$log"; }
say "visual pass $(git rev-parse --short HEAD) $(date -u +%FT%TZ) cells: $cells"

run npm --prefix "$repo" run build >>"$log" 2>&1 || { say "FAIL visual pass: npm run build failed, see $log"; exit 2; }

# One planned base per fixture (make --no-jev: no model calls), then one copy per cell.
base() { # <name> <generator...>
  local d=$TAKEONE_DIR/base-$1; shift
  [ -n "$only" ] && [ -s "$d/take.json" ] && [ -d "$d/analysis" ] && return
  rm -rf "$d"; run node "$@" "$d" >/dev/null
  run node bin/takeone.mjs make "$d" --no-jev > "$d.make.log" 2>&1 || { cat "$d.make.log" >&2; return 1; }
}
cell() { # <cell> <base> [render args...]: prints the cell's take dir
  local c=$1 b=$TAKEONE_DIR/base-$2 d=$TAKEONE_DIR/$1; shift 2
  [ -n "$only" ] && [ -d "$d/out" ] && { echo "$d"; return; }
  rm -rf "$d"; cp -r "$b" "$d"
  if [ $# -gt 0 ]; then run node bin/takeone.mjs render "$d" "$@" > "$d.render.log" 2>&1 || { cat "$d.render.log" >&2; return 1; }; fi
  echo "$d"
}
want() { case " $cells " in *" $1 "*) return 0;; esac; return 1; }

fail=0; rows=()
check() {
  local c=$1 d=$2 th=$3 rc=0 v; shift 3
  local film; film=$(ls "$d"/out/*.mp4 | head -1); cp "$film" "$out/$c.mp4"
  run node "$here/visual-check.ts" "$d" --name "$c" --out "$out" --theme "$th" --film "$out/$c.mp4" "$@" > "$work/$c.check.log" 2>&1 || rc=$?
  cat "$work/$c.check.log" >> "$log"
  case $rc in 0) v=PASS;; 1) v=FAIL; fail=1;; *) v=ERROR; fail=1;; esac
  say "$v $c (exit $rc)"
  rows+=("| $c | $v | $(cd "$out" && ls "$c"-t*-side.png 2>/dev/null | tr '\n' ' ') | $(grep -c '^FAIL .* t=' "$work/$c.check.log" || true) |")
}
mref() { [ -n "$ref" ] && [ -s "$ref/$1.mp4" ] && echo "--ref $ref/$1.mp4" || true; }

want desktop-dark || want desktop-light && base desktop scripts/synth-take.ts
want portrait-dark || want portrait-light || want 45-dark || want 45-light && base portrait scripts/synth-portrait.ts
want font-dark || want font-light || want motion-dark || want motion-light && base font "$here/synth-phone-font.ts"
for c in $cells; do
  case $c in
    desktop-dark) d=$(cell "$c" desktop) th=midnight;;
    desktop-light) d=$(cell "$c" desktop --theme paper) th=paper;;
    portrait-dark) d=$(cell "$c" portrait) th=midnight;;
    portrait-light) d=$(cell "$c" portrait --theme paper) th=paper;;
    45-dark) d=$(cell "$c" portrait --aspect 4:5) th=midnight;;
    45-light) d=$(cell "$c" portrait --aspect 4:5 --theme paper) th=paper;;
    font-dark) d=$(cell "$c" font) th=midnight;;
    font-light) d=$(cell "$c" font --theme paper) th=paper;;
    motion-dark|motion-light)
      th=$([ "$c" = motion-dark ] && echo midnight || echo paper); d=$TAKEONE_DIR/$c
      [ -n "$only" ] && [ -d "$d/out" ] || { rm -rf "$d"; run node bin/takeone.mjs motion "$TAKEONE_DIR/base-font/sources/board.png" "$TAKEONE_DIR/base-font/sources/sheet.png" \
        --device phone --theme "$th" --title "Plan the launch" --out "$d" > "$work/$c.motion.log" 2>&1 || { cat "$work/$c.motion.log" >&2; exit 2; }; }
      check "$c" "$d" "$th" "${mrefs[@]}"; continue;;
    *) echo "visual-pass: unknown cell $c" >&2; exit 2;;
  esac
  # shellcheck disable=SC2046
  check "$c" "$d" "$th" $(mref "$c")
done

{ echo "# Visual defect pass $(git rev-parse --short HEAD)"; echo
  echo "Reference: ${ref:-none} ${mrefs[*]:-}"; echo
  echo "| cell | verdict | side-by-side sheets | defects |"; echo "|---|---|---|---|"; printf '%s\n' "${rows[@]}"; } > "$out/index.md"
# Required last step (skipped with --no-design): the done-done design check judges every
# cell still (exit 1 fail, exit 3 genuine unsure and exit 4 judge-unavailable all fail the pass). Stills take their mock
# from the reference pass's film (motion cells included); the --motion-ref contacts stay
# side-sheet references only, never design mocks (a mock showing other content fails good
# stills, see visual-design.sh).
dargs=(); [ -n "$ref" ] && dargs+=(--ref "$ref")
if [ -n "$nodesign" ]; then say "SKIP design check (--no-design reference run)"
else
drc=0; "$here/visual-design.sh" "$out" "${dargs[@]}" || drc=$?
case $drc in 0) say "PASS design check";; 3) say "FAIL design check: unsure, needs a human look"; fail=1;; 4) say "FAIL design check: JUDGE UNAVAILABLE (no model answered; not a design verdict)"; fail=1;; *) say "FAIL design check (exit $drc)"; fail=1;; esac
fi
say "$([ $fail = 0 ] && echo PASS || echo FAIL) visual pass: see $out/index.md"
exit $fail
