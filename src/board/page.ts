// The page a sign-off design card opens for one demo option: the cut plays in place, with its judge
// score, rubric, the owner's feedback and what changed. Made with first-draft (`first-draft-axi make`, then `refine`
// from the independent critic's gaps); the sample text became the fields below. Light and dark, phone and desktop, no
// network: the board serves the video and poster from beside the page.

export interface CutPageData {
  /** "A", "B" or "C". */
  badge: string;
  badgeLabel: string;
  title: string;
  /** The independent judge's score out of 10; null when the option was not judged. */
  score: number | null;
  target: number;
  /** "Recommended cut", "Final cut", or nothing. */
  pill?: string;
  status: string[];
  items: { label: string; score: number; note: string }[];
  feedback: { text: string; kept: boolean | null; reason: string }[];
  changes: string[];
  cost: string;
  video: string;
  poster: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const CHECK = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7"></path></svg>';
const MINUS = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10"></path></svg>';
const pct = (n: number) => `${Math.max(0, Math.min(100, Math.round(n * 10)))}%`;

const CSS = `
:root {
  --background: #FFFFFF;
  --surface: #F3F6FA;
  --frame: #E6ECF3;
  --video-ground: #080C12;
  --text: #1C2938;
  --muted: #506174;
  --rule: #D5DFEA;
  --recommendation: #315E91;
  --pill-text: #FFFFFF;
  --met: #236044;
  --met-surface: #DFEFE6;
  --unmet: #80501F;
  --unmet-surface: #F6EADB;
  --space: 8px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --background: #101720;
    --surface: #1C2837;
    --frame: #2B3B4F;
    --video-ground: #080C12;
    --text: #EDF3FA;
    --muted: #B9C7D8;
    --rule: #405168;
    --recommendation: #A8CDF7;
    --pill-text: #142C48;
    --met: #A0DFBC;
    --met-surface: #243F35;
    --unmet: #F3CCA0;
    --unmet-surface: #443426;
  }
}
* { box-sizing: border-box; min-width: 0; }
body { margin: 0; background: var(--background); color: var(--text); }
.review { width: 100%; max-width: 1120px; margin-inline: auto; padding: 20px 24px 0; container-type: inline-size; }
.video-frame { padding: 6px; border: 1px solid var(--rule); border-radius: 16px; background: var(--frame); overflow: hidden; }
.video { display: block; width: 100%; aspect-ratio: 16 / 9; max-height: 56vh; object-fit: contain; background: var(--video-ground); border-radius: 10px; }
.video:focus-visible { outline: 3px solid var(--recommendation); outline-offset: -3px; }
.sheet { padding: 20px 8px 16px; }
.verdict { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px 20px; align-items: center; padding-bottom: 20px; }
.identity { display: flex; align-items: center; gap: 12px; }
.badge { display: grid; place-items: center; flex: 0 0 32px; height: 32px; border: 1px solid var(--rule); border-radius: 6px; font-size: 16px; font-weight: 700; }
h1 { margin: 0; font-size: 16px; line-height: 22px; font-weight: 600; max-width: 50ch; text-wrap: pretty; }
.score { width: 112px; white-space: nowrap; }
.score-value { font-size: 48px; line-height: 48px; font-weight: 700; letter-spacing: -2px; font-variant-numeric: tabular-nums; }
.score-unit { font-size: 14px; line-height: 20px; font-weight: 400; letter-spacing: 0; color: var(--muted); margin-left: 3px; }
.target-track { display: block; position: relative; height: 4px; margin-top: 6px; border-radius: 2px; background: var(--rule); }
.target-fill { display: block; height: 100%; border-radius: inherit; background: var(--recommendation); }
.target-marker { position: absolute; top: -3px; width: 1px; height: 10px; background: var(--text); }
.target { display: block; margin-top: 5px; font-size: 11px; line-height: 16px; color: var(--muted); }
.round-status { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; font-size: 11px; line-height: 16px; color: var(--muted); }
.recommendation { color: var(--pill-text); background: var(--recommendation); border-radius: 999px; padding: 8px 12px; font-size: 12px; line-height: 18px; white-space: nowrap; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; }
.icon { display: block; width: 14px; height: 14px; flex: 0 0 14px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.evidence { display: grid; grid-template-columns: minmax(0, 55fr) minmax(0, 45fr); gap: 32px; align-items: start; }
h2 { font-size: 11px; line-height: 16px; letter-spacing: 1.3px; text-transform: uppercase; font-weight: 700; margin: 0 0 12px; color: var(--muted); }
.feedback { background: var(--surface); border-radius: 8px; padding: 16px; }
.feedback-list, .changes-list, .rubric-list { list-style: none; padding: 0; margin: 0; }
.feedback-item + .feedback-item { margin-top: 12px; }
.feedback-item.is-unmet { background: var(--unmet-surface); border-radius: 6px; padding: 12px; }
blockquote { margin: 0 0 6px; font-size: 14px; line-height: 20px; font-weight: 500; }
.outcome { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; line-height: 19px; }
.state { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 999px; flex-shrink: 0; font-size: 11px; line-height: 16px; font-weight: 600; white-space: nowrap; }
.met { color: var(--met); background: var(--met-surface); }
.unmet { color: var(--unmet); background: var(--background); }
.reason { color: var(--muted); padding-top: 1px; }
.changes { margin-top: 20px; }
.changes h2 { margin-bottom: 8px; }
.changes-list { display: grid; gap: 6px; font-size: 12px; line-height: 18px; }
.change { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 6px; }
.before { color: var(--muted); }
.arrow { color: var(--muted); }
.rubric-heading { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; }
.rubric-heading span { color: var(--muted); font-size: 11px; line-height: 16px; white-space: nowrap; }
.rubric-row { padding: 8px 0; border-top: 1px solid var(--rule); }
.rubric-top { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; font-size: 12px; line-height: 18px; }
.rubric-name { font-weight: 600; }
.rubric-score { white-space: nowrap; font-weight: 600; font-variant-numeric: tabular-nums; }
.rubric-score span { color: var(--muted); font-weight: 400; }
.rubric-bar { display: block; height: 3px; width: 72px; margin-top: 5px; border-radius: 2px; background: var(--rule); overflow: hidden; }
.rubric-bar span { display: block; height: 100%; border-radius: inherit; background: var(--recommendation); }
.rubric-note { margin: 5px 0 0; color: var(--muted); font-size: 13px; line-height: 19px; }
.cost { margin: 20px 0 0; padding-top: 12px; border-top: 1px solid var(--rule); color: var(--muted); font-size: 11px; line-height: 16px; }
@container (max-width: 660px) {
  .sheet { padding: 16px 0; }
  .verdict { grid-template-columns: minmax(0, 1fr) auto; gap: 12px; padding-bottom: 20px; }
  .identity { grid-column: 1 / -1; gap: 8px; }
  .score { width: 112px; }
  .recommendation { justify-self: end; }
  .evidence { grid-template-columns: minmax(0, 1fr); gap: 24px; }
  .feedback { padding: 16px; }
  .cost { margin-top: 16px; }
}
@media (max-width: 700px) { .review { padding: 16px 16px 0; } .video-frame { padding: 4px; border-radius: 12px; } .video { border-radius: 8px; } }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; }
}
`;

export function cutPage(d: CutPageData): string {
  const score = d.score === null ? "–" : d.score.toFixed(1);
  const scoreLabel = d.score === null ? "Not judged." : `Independent judge score: ${score} out of 10. Target: ${d.target} out of 10.`;
  const feedback = d.feedback.length === 0 ? "" : `
        <section class="feedback" aria-labelledby="feedback-title">
          <h2 id="feedback-title">Owner feedback</h2>
          <ul class="feedback-list">${d.feedback.map((f) => `
            <li class="feedback-item${f.kept === false ? " is-unmet" : ""}">
              <blockquote>“${esc(f.text)}”</blockquote>
              <div class="outcome">${f.kept === null ? '<span class="state">Not checked</span>' : f.kept ? `<span class="state met">${CHECK}Met</span>` : `<span class="state unmet">${MINUS}Not met</span>`}<span class="reason">${esc(f.reason)}</span></div>
            </li>`).join("")}
          </ul>
        </section>`;
  const changes = d.changes.length === 0 ? "" : `
        <section class="changes" aria-labelledby="changes-title">
          <h2 id="changes-title">Changes this round</h2>
          <ul class="changes-list">${d.changes.map((c) => `
            <li class="change"><span>${esc(c)}</span></li>`).join("")}
          </ul>
        </section>`;
  const rubric = d.items.length === 0 ? "" : `
      <section class="rubric" aria-labelledby="rubric-title">
        <div class="rubric-heading"><h2 id="rubric-title">Independent rubric</h2><span>Score /10</span></div>
        <ul class="rubric-list">${d.items.map((i) => `
          <li class="rubric-row"><div class="rubric-top"><span class="rubric-name">${esc(i.label)}</span><span class="rubric-score">${i.score}<span>/10</span></span></div><span class="rubric-bar" aria-hidden="true"><span style="width:${pct(i.score)}"></span></span><p class="rubric-note">${esc(i.note)}</p></li>`).join("")}
        </ul>
      </section>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(d.badge)} · ${esc(d.title)}</title>
<style>${CSS}</style>
</head>
<body>
<main class="review" aria-label="Demo video cut review">
  <div class="video-frame">
    <video class="video" controls playsinline preload="metadata" src="${esc(d.video)}" poster="${esc(d.poster)}" aria-label="${esc(`${d.title}, ${d.badgeLabel}`)}">
      Your browser does not support embedded video. <a href="${esc(d.video)}">Open the demo cut</a>.
    </video>
  </div>
  <div class="sheet">
    <header class="verdict">
      <div class="identity">
        <span class="badge" aria-label="${esc(d.badgeLabel)}">${esc(d.badge)}</span>
        <h1>${esc(d.title)}</h1>
      </div>
      <div class="score" aria-label="${esc(scoreLabel)}">
        <div class="score-value">${score}<span class="score-unit">/10</span></div>
        <span class="target-track" aria-hidden="true"><span class="target-fill" style="width:${pct(d.score ?? 0)}"></span><span class="target-marker" style="left:${pct(d.target)}"></span></span>
        <span class="target">Target ${d.target}/10</span>
      </div>
      ${d.pill ? `<span class="recommendation">${CHECK}${esc(d.pill)}</span>` : "<span></span>"}
      <div class="round-status">${d.status.map((s) => `
        <span>${esc(s)}</span>`).join("")}
      </div>
    </header>
    <div class="evidence">
      <div class="iteration">${feedback}${changes}
      </div>${rubric}
    </div>
    <footer class="cost">${esc(d.cost)}</footer>
  </div>
</main>
</body></html>
`;
}
