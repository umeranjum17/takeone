#!/usr/bin/env node
// Adapted from constraint-driven-development/references/floor-guard.md.
// ponytail: regex-shallow diff guard; review semantics and use a secret scanner for exhaustive detection.
// Usage: node floor-guard.mjs [--base <ref>]   (default base: origin/main)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const base = (() => {
  const i = process.argv.indexOf('--base');
  return i > -1 ? process.argv[i + 1] : 'origin/main';
})();

// `git diff --no-index` exits 1 whenever the two sides differ, which is the normal case for a
// new file, so that output is kept. Any other failure is null, and null never reads as clean.
const git = (args, { diffExit = false } = {}) => {
  try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }); }
  catch (e) { return diffExit && e.status === 1 && typeof e.stdout === 'string' ? e.stdout : null; }
};
const bail = (msg) => { console.error('floor-guard: ' + msg); process.exit(2); };

// Run from the top of the work tree. `git ls-files` lists only the current directory's subtree,
// relative to it, so a guard started in a subfolder would miss untracked files elsewhere and name
// the rest differently from `git diff`, which always covers the whole tree.
const top = git(['rev-parse', '--show-toplevel'])?.trim();
if (!top) bail('not inside a git work tree');
process.chdir(top);

// Merge base; bail to exit 2 rather than pretending a shallow/rootless clone is clean.
const mergeBase = git(['merge-base', base, 'HEAD'])?.trim();
if (!mergeBase) bail('no merge base against ' + base);

// Unified diff plus untracked files (git diff alone cannot see new files).
const tracked = git(['diff', '--src-prefix=a/', '--dst-prefix=b/', '--unified=0', mergeBase, '--']);
if (tracked === null) bail('could not diff against ' + mergeBase);
const untrackedFiles = git(['ls-files', '--others', '--exclude-standard', '-z']);
if (untrackedFiles === null) bail('could not list untracked files');
const untracked = untrackedFiles.split('\0').filter(Boolean).map((f) => {
  const d = git(['diff', '--no-index', '--src-prefix=a/', '--dst-prefix=b/', '--unified=0', '/dev/null', f], { diffExit: true });
  if (d === null) bail('could not diff untracked file ' + f);
  return d;
}).join('\n');
const diff = tracked + '\n' + untracked;

// Walk the diff. `---` and `+++` are file headers only between a file's `diff` line and its first
// `@@` hunk; inside a hunk every line is content, so an added `++i` (shown as `+++i`) or a removed
// `-- comment` is a change, not a header. Both headers name the file, so a deletion
// (`+++ /dev/null`) keeps its name. A hunk header names the line each side starts at, so every
// changed line knows where it sits in the file before the diff and in the file after it.
const added = [], removed = [], deleted = [];
const pathOf = (s) => s.replace(/^[ab]\//, '');
let file = '', oldFile = '', inHeader = false;
let oldLine = 0, newLine = 0;
for (const line of diff.split('\n')) {
  if (line.startsWith('diff ')) inHeader = true;
  else if (line.startsWith('@@')) {
    inHeader = false;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    oldLine = hunk ? Number(hunk[1]) : 0;
    newLine = hunk ? Number(hunk[2]) : 0;
  }
  else if (inHeader) {
    if (line.startsWith('--- ')) oldFile = pathOf(line.slice(4));
    else if (line.startsWith('+++ ')) {
      const newFile = pathOf(line.slice(4));
      file = newFile === '/dev/null' ? oldFile : newFile;
      if (newFile === '/dev/null') deleted.push(file);
    }
  }
  else if (line.startsWith('+')) added.push({ file, text: line.slice(1), line: newLine++ });
  else if (line.startsWith('-')) removed.push({ file, text: line.slice(1), line: oldLine++ });
  else { oldLine++; newLine++; }   // a context line sits on both sides
}

const findings = [];
// Never emit matched content: violations can contain credentials.
const flag = (rule, f) => findings.push({ rule, file: f });
const isTest = (f) => /\.(test|spec)\.|_test\.|test_|(^|\/)tests?\/|(^|\/)test-|^scripts\/e2e\//.test(f);
const isCode = (f) => /\.(ts|js|mjs|cjs|py|go|rs|sh)$/.test(f);
const testDiet = (f) => {
  if (git(['diff', '--quiet', 'HEAD', '--', f]) === null) return false;
  const message = git(['log', '-1', '--format=%B', `${mergeBase}..HEAD`, '--', f]) ?? '';
  const journey = /^Test-diet-journey: (\S+) :: (\S.+)$/m.exec(message);
  if (!/^Test-diet-task: \S*test-diet\S*$/m.test(message) || !/^Test-change-reason: \S.+/m.test(message) || !journey) return false;
  const path = journey[1];
  if (!isTest(path) || path === f) return false;
  const before = git(['show', `${mergeBase}:${path}`]);
  const current = git(['show', `HEAD:${path}`]);
  // The CLI checks a retained journey, not semantic coverage: review must prove the named journey still covers the deletion.
  return Boolean(before?.trim()) && Boolean(current?.trim()) && git(['diff', '--quiet', 'HEAD', '--', path]) !== null;
};
const isConstraints = (f) => /CONSTRAINTS\.md$/.test(f);

// 1. Silenced checker — extend this list for your ecosystem.
const SUPPRESSIONS = /@ts-ignore|@ts-nocheck|eslint-disable|biome-ignore|# *noqa|# *type: *ignore|istanbul ignore|nosemgrep|gitleaks:allow|Stryker disable/;
// 4. Unfinished work.
const STUBS = /throw new (Error|NotImplemented).*[Nn]ot implemented|catch\s*\(\w*\)\s*\{\s*\}|catch\s*\{\s*\}|\bpass\s*# *stub/;
const SECRETS = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|sk-[A-Za-z0-9_-]{32,})\b/;
// 2. A test made easier (added skips).
const SKIPS = /\.(skip|todo)\b|\b(skip|todo)["']?\s*:(?!\s*false\s*(?:[,}]|$))|\bxit\(|\bxdescribe\(|@pytest\.mark\.skip|t\.Skip\(/;

// A changed timeout re-adds the declaration's existing ffmpeg prerequisite.
// Compare simple skip fields only within the same BASE declaration; uncertain
// expressions and other skip forms remain findings rather than gaining an exemption.
// A NEW declaration may also declare the project's prerequisite sentinel: a local
// binding whose value is `condition ? undefined : "reason"`, so the test runs
// whenever the prerequisite is present. Any other skip field still counts.
const TEST_DECLARATION = /\b(?:test|it|describe)\s*\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/;
const SKIP_FIELD = /\b(skip|todo)["']?\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(?=[,}]|$)/g;
const identifier = (name) => /^[A-Za-z_$][\w$]*$/.test(name) ? name : null;
function prerequisiteSentinel(file, name) {
  if (!identifier(name)) return false;
  let source;
  try { source = readFileSync(join(top, file), 'utf8'); } catch { return false; }
  const declaration = new RegExp(`\\b(?:const|let|var)\\s+${identifier(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
    + `\\s*=\\s*[^;\\n]*\\?\\s*undefined\\s*:`);
  return declaration.test(source);
}
function prerequisiteSkip(file, text) {
  const fields = [...text.matchAll(SKIP_FIELD)].filter(f => f[1] === 'skip' || f[1] === 'todo');
  return fields.length === 1 && prerequisiteSentinel(file, fields[0][2]);
}
function addedSkip(file, text) {
  const declaration = TEST_DECLARATION.exec(text)?.[0];
  const before = declaration && removed.find(r => r.file === file
    && TEST_DECLARATION.exec(r.text)?.[0] === declaration)?.text;
  if (!before) return prerequisiteSkip(file, text) ? false : SKIPS.test(text);
  const fields = [...before.matchAll(SKIP_FIELD)];
  const changed = text.replace(SKIP_FIELD, (token, key, value) =>
    fields.some(f => f[1] === key && f[2] === value) ? '' : token);
  return SKIPS.test(changed);
}

for (const { file, text } of added) {
  if (isCode(file) && /(^\s*(\/\/|\/\*|\*|#)|\s(\/\/|\/\*|#))/.test(text) && SUPPRESSIONS.test(text)) flag('silenced-checker', file);
  if (isCode(file) && STUBS.test(text)) flag('unfinished-work', file);
  if (isTest(file) && addedSkip(file, text)) flag('test-made-easier', file);
  if (SECRETS.test(text)) flag('secret-in-source', file);
  if (isConstraints(file) && /^\| *(W|E)\d+ *\|/.test(text)) flag('new-exception', file, text);
}

// 2b. A test file deleted, or an assertion removed from a test file that still exists.
// The documented test-diet exception (CONSTRAINTS.md) applies to both shapes: a deletion inside a
// surviving test file is what an intentional test-diet PR actually looks like, so without the
// testDiet check here the exception would be unreachable for the only case it exists for.
for (const f of deleted) if (isTest(f) && !testDiet(f)) flag('test-deleted', f);
// A removed assertion is covered only by an added line asserting on the same subject:
// the first argument of assert.verb(...) / expect(...), normalised (whitespace collapsed,
// numeric indices masked so a beat cut shifting [2] to [1] still pairs). Whole-line
// identity is the fallback for unparseable lines. Net count is necessary but never
// sufficient: a pure count balance must not clear a specific unmatched removal (a swap -
// one assertion deleted, one unrelated added - nets to zero and still lowers the bar).
// A subject the added line does not share is covered the other way round: the test block
// the removal left can gain the check, when that block gained at least as many assertions
// as it lost and one of them checks the same quantity without lowering its bar. That is
// the one case a rewritten check is a stronger check, not a removed one.
const ASSERT_LINE = /\b(expect|assert|should)\b/;
const normSubject = (s) => s.replace(/\s+/g, " ").trim().replace(/\[\d+\]/g, "[]");
function assertedArgs(line) {
  const t = line.trim().replace(/;\s*$/, "");
  const m = /assert\.[A-Za-z]+\s*\(|expect\s*\(/.exec(t);
  if (!m) return [t];
  const args = []; // split the call's argument list at top-level commas
  let depth = 0, cur = "", quote = null;
  const start = m.index + m[0].length;
  let i = start;
  for (; i < t.length; i++) {
    const c = t[i];
    if (quote) { cur += c; if (c === "\\") { cur += t[++i] ?? ""; } else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; cur += c; continue; }
    if (c === "(") { depth++; cur += c; continue; }
    if (c === ")") {
      if (!depth) break;
      depth--; cur += c; continue;
    }
    if (c === "," && !depth) { args.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (i >= t.length) return [t]; // unbalanced: strict fallback
  args.push(cur);
  return args;
}
function assertedSubject(line) {
  return normSubject(assertedArgs(line)[0] ?? "");
}
// Pair a rename only when every changed word is consistently new to the file, or when the same
// one-word swap recurs in 2+ assertion pairs of the file (`r.jev.failed` -> `r.planner.failed` across
// a test file that still names the jev provider), or when this diff deletes the old field from src/
// and src/ has the new one (`r2.response` -> `r2.answers` once the code under test lost `.response`).
// A one-off test-only swap (r.failed -> r.skipped) stays flagged.
// ponytail: a one-off swap whose old word leaves the file entirely still pairs; review owns that.
const WORD = /[A-Za-z_$][\w$]*/g;
const shapeOf = (s) => s.replace(WORD, 'w');
const hasWord = (text, w) => new RegExp(`(?<![\\w$])${w.replaceAll('$', '\\$')}(?![\\w$])`).test(text);
const wordChanges = (a, b) => {
  if (a === b || shapeOf(a) !== shapeOf(b)) return [];
  const wa = a.match(WORD) ?? [], wb = b.match(WORD) ?? [];
  return wa.map((w, i) => [w, wb[i]]).filter(([oldWord, newWord]) => oldWord !== newWord);
};
const assertsLost = [], assertsGained = [];
for (const { file, text, line } of removed) if (isTest(file) && ASSERT_LINE.test(text)) assertsLost.push({ file, subject: assertedSubject(text), args: assertedArgs(text), line });
for (const { file, text, line } of added) if (isTest(file) && ASSERT_LINE.test(text)) assertsGained.push({ file, subject: assertedSubject(text), args: assertedArgs(text), line });
// The test block a changed assertion sits in, named by the test's own declaration. A removal is
// judged against the block it left (the file before the diff) and an addition against the block it
// joined (the file after it), so a renamed test reads as two different blocks.
const DECLARATION = /^\s*(?:test|it|describe)\s*\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/;
const blockNames = (content) => {
  const names = [];
  let current = null;
  for (const line of content.split('\n')) {
    const m = DECLARATION.exec(line);
    if (m) current = m[1].slice(1, -1);
    names.push(current);
  }
  return names;
};
const blockCache = new Map();
const blockOf = (file, side, line) => {
  const key = side + ' ' + file;
  let names = blockCache.get(key);
  if (names === undefined) {
    const content = side === 'before'
      ? (git(['show', `${mergeBase}:${file}`]) ?? '')
      : (existsSync(file) ? readFileSync(file, 'utf8') : '');
    names = blockNames(content);
    blockCache.set(key, names);
  }
  return names[line - 1] ?? null;
};
for (const l of assertsLost) l.block = blockOf(l.file, 'before', l.line);
for (const g of assertsGained) g.block = blockOf(g.file, 'after', g.line);
const swapCount = new Map(); // "file|old|new" -> lost/gained pairs differing in exactly that word
for (const l of assertsLost) for (const g of assertsGained) {
  const changed = g.file === l.file ? wordChanges(l.subject, g.subject) : [];
  if (changed.length === 1) { const k = `${l.file}|${changed[0].join('|')}`; swapCount.set(k, (swapCount.get(k) ?? 0) + 1); }
}
// A field used as `.name`, or declared or keyed as `name:` / `name?:`, in non-test src/ (worktree when no rev).
const fieldInSrc = (w, rev) => {
  const e = w.replaceAll('$', '\\$');
  const re = `\\.${e}([^A-Za-z0-9_$]|$)|(^|[{,])[[:space:]]*${e}\\??[[:space:]]*:`;
  const out = git(['grep', '-l', '-E', re, ...(rev ? [rev] : []), '--', 'src']) ?? '';
  return out.split('\n').map((l) => (rev ? l.slice(rev.length + 1) : l)).some((f) => f && isCode(f) && !isTest(f));
};
const fieldRenamed = (oldWord, newWord) => fieldInSrc(oldWord, mergeBase) && !fieldInSrc(oldWord) && fieldInSrc(newWord);
const renamed = (file, a, b, before, after) => {
  const changed = wordChanges(a, b);
  return changed.length > 0 && changed.every(([oldWord, newWord]) =>
    (!hasWord(after, oldWord) && !hasWord(before, newWord)) || (swapCount.get(`${file}|${oldWord}|${newWord}`) ?? 0) >= 2) ||
    (changed.length === 1 && fieldRenamed(...changed[0]));
};
// A call that lost one argument pairs when this diff drops parameters from that function in src/:
// `captionLayouts(captions, ink, d, false, band)` -> `captionLayouts(captions, ink, d, band)` once
// captionLayouts lost its widePhone parameter. A test-only argument drop, or one whose function kept
// its arity in src/, stays flagged.
// ponytail: top-level commas split the parameter list, so a generic type with a comma miscounts it
// and the pair stays flagged; review owns that.
const listAt = (s, open) => { // the top-level items between s[open] === '(' and its closing ')'
  const items = [];
  let depth = 0, cur = '', quote = null;
  for (let i = open + 1; i < s.length; i++) {
    const c = s[i];
    if (quote) { cur += c; if (c === '\\') cur += s[++i] ?? ''; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' && !depth) { if (cur.trim()) items.push(cur.trim()); return { items, end: i }; }
    if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && !depth) { items.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  return null;
};
const CALLEE = /[A-Za-z_$][\w$]*(?=\()/g;
const droppedArgCallee = (a, b) => {
  for (const m of a.matchAll(CALLEE)) {
    const open = m.index + m[0].length, call = listAt(a, open);
    if (!call) continue;
    for (let k = 0; k < call.items.length; k++) {
      const without = call.items.filter((_, i) => i !== k).join(', ');
      if (normSubject(a.slice(0, open + 1) + without + a.slice(call.end)) === normSubject(b)) return m[0];
    }
  }
  return null;
};
const arity = (name, rev) => {
  const declared = new RegExp(`function\\s+${name.replaceAll('$', '\\$')}\\s*\\(`);
  const out = git(['grep', '-l', '-E', `function[[:space:]]+${name.replaceAll('$', '\\$')}[[:space:]]*\\(`, ...(rev ? [rev] : []), '--', 'src']) ?? '';
  for (const f of out.split('\n').map((l) => (rev ? l.slice(rev.length + 1) : l)).filter((f) => f && isCode(f) && !isTest(f))) {
    const content = rev ? git(['show', `${rev}:${f}`]) ?? '' : readFileSync(f, 'utf8');
    const at = content.search(declared);
    const params = at < 0 ? null : listAt(content, content.indexOf('(', at));
    if (params) return params.items.length;
  }
  return null;
};
const argDropped = (a, b) => {
  const name = droppedArgCallee(a, b);
  if (!name) return false;
  const was = arity(name, mergeBase), now = arity(name);
  return was !== null && now !== null && now < was;
};
// The comparison an assertion makes: its operator and its two sides.
function subjectComparison(subject) {
  let depth = 0, quote = null;
  for (let i = 0; i < subject.length; i++) {
    const c = subject[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; continue; }
    if (depth !== 0) continue;
    if (c !== '=' && c !== '!' && c !== '<' && c !== '>') continue;
    if (subject.slice(i, i + 2) === '=>') { i++; continue; }   // an arrow function, not a comparison
    const op = ['===', '!==', '>=', '<=', '==', '!='].find((o) => subject.startsWith(o, i)) ?? c;
    return { op, left: subject.slice(0, i).trim(), right: subject.slice(i + op.length).trim() };
  }
  return null;
}
// The quantity an assertion checks: the left side of its comparison, or its whole first argument
// when it compares nothing. "planned >= tokens(a) + tokens(b)" and "planned >= tokens(c) * 2 - 1200"
// both check "planned"; "r.jev.failed" and "r.planner.failed" do not check the same thing.
function subjectHead(subject) {
  const comparison = subjectComparison(subject);
  if (comparison) return normSubject(comparison.left);
  let depth = 0, quote = null, cut = -1;
  for (let i = 0; i < subject.length; i++) {
    const c = subject[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; continue; }
    if (depth === 0 && c === ',') { cut = i; break; }
  }
  return normSubject(cut < 0 ? subject : subject.slice(0, cut));
}
// The value an equality assertion pins, when it pins a bare number.
function pinnedValue(args) {
  if (args.length < 2) return null;
  const m = /^(-?\d+(?:\.\d+)?)$/.exec(args[1].trim());
  return m ? Number(m[1]) : null;
}
// The bar an assertion sets and how it states it: a number the guard can compare, or an expression
// it cannot. A comparison to an expression states a bar the guard has to take on trust.
function assertionBar(a) {
  const comparison = subjectComparison(a.subject);
  if (comparison) {
    const number = /^(-?\d+(?:\.\d+)?)$/.exec(comparison.right);
    let bar = null;
    const value = number ? Number(number[1]) : 0;
    if (comparison.op === '>=' || comparison.op === '>') bar = { dir: 'min', value: comparison.op === '>' ? value + 1 : value };
    else if (comparison.op === '<=' || comparison.op === '<') bar = { dir: 'max', value: comparison.op === '<' ? value - 1 : value };
    else if (comparison.op === '===' || comparison.op === '==') bar = { dir: 'eq', value };
    return { op: comparison.op, kind: number ? 'number' : 'expression', bar };
  }
  const pinned = pinnedValue(a.args);
  return pinned === null ? null : { op: '==', kind: 'number', bar: { dir: 'eq', value: pinned } };
}
const opGroup = (op) => op === '>=' || op === '>' ? 'min' : op === '<=' || op === '<' ? 'max' : op === '==' || op === '===' ? 'eq' : 'ne';
// A covering check may not lower the bar the removed one set, and may not state a weaker kind of
// check: a number where the removed one compared two expressions proves less than the old check.
function lowersBar(added, removed) {
  const was = assertionBar(removed);
  if (!was) return false;   // the removed assertion sets no bar to lower
  const now = assertionBar(added);
  if (!now) return true;    // the added one states none either: it cannot be shown to cover
  if (opGroup(was.op) !== opGroup(now.op)) return true;
  if (was.kind === 'expression') return now.kind !== 'expression';
  if (now.kind !== 'number' || !was.bar || !now.bar) return true;
  if (was.bar.dir === 'eq') return now.bar.dir !== 'eq' || now.bar.value !== was.bar.value;
  if (now.bar.dir !== was.bar.dir) return true;
  return was.bar.dir === 'min' ? now.bar.value < was.bar.value : now.bar.value > was.bar.value;
}
// A stronger check replaces a removed one when it checks the same quantity and does not lower the
// bar the removed one set.
const covers = (added, removed) =>
  subjectHead(added.subject) === subjectHead(removed.subject) && !lowersBar(added, removed);
// A removal is excused when the test block it left gained at least as many assertions and one of
// them covers the removed subject: the same block now checks the same thing, at least as hard.
// A removal in a block that gained nothing, or whose additions check other things, stays flagged.
const strengthened = (lost) => {
  if (!lost.block) return false;
  const lostInBlock = assertsLost.filter(l => l.file === lost.file && l.block === lost.block).length;
  const gainedInBlock = assertsGained.filter(g => g.file === lost.file && g.block === lost.block);
  if (gainedInBlock.length < lostInBlock) return false;
  return gainedInBlock.some(g => covers(g, lost));
};
for (const lost of assertsLost) {
  if (deleted.includes(lost.file) || testDiet(lost.file)) continue; // test-deleted / test-diet own these
  const before = git(['show', `${mergeBase}:${lost.file}`]) ?? '';
  const after = existsSync(lost.file) ? readFileSync(lost.file, 'utf8') : '';
  const match = assertsGained.findIndex(g => g.file === lost.file && (g.subject === lost.subject || renamed(lost.file, lost.subject, g.subject, before, after) || argDropped(lost.subject, g.subject)));
  if (match < 0 && strengthened(lost)) continue;   // the same block now checks it, at least as hard
  const netLoss = assertsLost.filter(l => l.file === lost.file).length > assertsGained.filter(g => g.file === lost.file).length;
  if (match < 0 || netLoss) flag('assertion-removed', lost.file, lost.subject);
}

// 1b/2c. A rule in CONSTRAINTS.md weakened or removed. A rule is a floor bullet or a table row,
// identified by the bullet's text before its first colon or by the row's first cell. Each number
// carries a direction read from the words around it: a minimum (>=, at least, must not fall) is
// loosened by going down, a maximum (<=, at most, under, must not grow) by going up. A number whose
// direction cannot be read is reported whenever it changes, because the guard cannot tell
// tightening from loosening and staying quiet is the wrong default. Numbers are paired within
// their direction (the first minimum with the first minimum, and so on), so a number added
// elsewhere in the text does not shift the pairing; a threshold with no counterpart after the
// edit was removed, and an added one tightens.
const ruleKey = (t) => {
  const s = t.trim();
  if (s.startsWith('|')) return s.split('|').map((c) => c.trim()).filter(Boolean)[0] ?? '';
  if (/^[-*] /.test(s)) return s.slice(2).split(':')[0].trim();
  return null; // prose, headings, dates: not a rule
};
const isException = (t) => /^\| *(W|E)\d+ *\|/.test(t.trim());
const MIN_BEFORE = /(>=|>|≥|at least|minimum|\bmin\b|no less than|not fall|not drop)\s*$/;
const MAX_BEFORE = /(<=|<|≤|at most|maximum|\bmax\b|no more than|under|below|not grow|not exceed)\s*$/;
const MIN_AFTER = /^\s*\S*\s*(or more|or higher|must not fall|must not drop)/;
const MAX_AFTER = /^\s*\S*\s*(or less|or lower|must not grow|must not exceed)/;
const thresholds = (t) => {
  const out = [], re = /\d+(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(t))) {
    const before = t.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 40).toLowerCase();
    const dir = MIN_BEFORE.test(before) || MIN_AFTER.test(after) ? 'min'
      : MAX_BEFORE.test(before) || MAX_AFTER.test(after) ? 'max' : null;
    out.push({ n: Number(m[0]), dir });
  }
  return out;
};
const removedRules = removed.filter((l) => isConstraints(l.file) && ruleKey(l.text) !== null);
const addedRules = added.filter((l) => isConstraints(l.file) && ruleKey(l.text) !== null);
for (const r of removedRules) {
  const a = addedRules.find((x) => ruleKey(x.text) === ruleKey(r.text));
  if (!a) {
    if (!isException(r.text)) flag('rule-removed', r.file, r.text); // dropping an exception tightens: silent
    continue;
  }
  const before = thresholds(r.text), after = thresholds(a.text);
  let verdict = null;
  for (const dir of ['min', 'max', null]) {
    const was = before.filter((x) => x.dir === dir), now = after.filter((x) => x.dir === dir);
    was.forEach((b, i) => {
      const n = now[i];
      if (verdict) return;
      if (!n) verdict = 'threshold-removed';
      else if (n.n === b.n) return;
      else if (dir === 'min' ? n.n < b.n : dir === 'max' ? n.n > b.n : true) {
        verdict = dir ? 'threshold-loosened' : 'threshold-changed';
      }
    });
  }
  if (verdict) flag(verdict, r.file, r.text + '  ->  ' + a.text);
}

if (findings.length === 0) { console.log('floor-guard: clean'); process.exit(0); }
console.error('floor-guard: ' + findings.length + ' floor violation(s):');
for (const f of findings) console.error(`  [${f.rule}] ${f.file}: matched content redacted`);
if (findings.some((f) => f.rule === 'rule-removed')) {
  console.error('\nA rule-removed finding can also mean the rule\'s label changed: rename a rule in one commit and change its thresholds in another.');
}
if (findings.some((f) => f.rule === 'threshold-removed')) {
  console.error('\nA threshold-removed finding can also mean a number gained or lost its direction words (">= 80%" becoming "80%", or the reverse): compare the two lines before assuming a threshold was deleted.');
}
console.error('\nEach is a move that lowers the bar. Fix the code, or route it through a tracked exception.');
process.exit(1);
