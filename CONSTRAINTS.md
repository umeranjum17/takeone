# Constraints

## Floor only

This adoption applies constraint-driven-development's Floor, without an interview,
numbered dimensions, coverage or mutation setup. Existing dependencies and quality
checks remain authoritative; this is not a release-quality qualification.

- No new suppression comments: TypeScript, lint, coverage and security checkers must not be silenced.
- No unimplemented stubs: no not-implemented throws or empty catches hiding failures.
- No skipped or deleted tests without a reason in the commit message: retain required consumer coverage.
- No secrets in source: findings must never print matched credential values.
- No weakening this file or existing motion, VMAF, quality, privacy or custody bars to make a change pass.

## Enforcement

Run `node scripts/floor-guard.mjs --base origin/main` before handoff and in CI.
It adapts the installed `constraint-driven-development/references/floor-guard.md`:
merge-base → working tree (staged, unstaged and untracked), exits 0 clean, 1 violation,
2 unable to check. A 2 is not a pass. `verify-takeone` and `.no-mistakes.yaml`
carry the real-product validation linkage; CI retains its existing checks.

The guard is regex-shallow, not a semantic proof or exhaustive secret scanner.
Review diffs for multiline stubs, arbitrary credentials, rewritten assertions and
wording-only policy relaxation; don't infer safety from a clean guard alone.
Documentation and regex declarations are not suppression comments.

Only intentional test-diet deletions can use the accepted exception. The deletion
commit must name its test-diet task AND the affected journey must stay covered by
an existing integration/e2e test; generic reasons or task mentions alone fail.
The guard requires these trailers on that file's latest change commit:

```text
Test-diet-task: <task-id-containing-test-diet>
Test-diet-journey: <existing-test-path> :: <specific affected journey>
Test-change-reason: <why that integration/e2e journey preserves required coverage>
```

The referenced journey must exist at the merge base and remain unchanged. Review
must verify it really drives and covers the affected journey: trailers alone are
not coverage proof. Uncommitted deletions, new skips and assertion removals block.
New exceptions and relaxed thresholds are reported, not silently accepted.
