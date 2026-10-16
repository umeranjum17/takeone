// The board choreography in frame numbers. Each layout's points are in its own design px
// (landscape: the original scene's 2560x1440; portrait 1080x1920; square 1080x1080). The
// headless scene fits that design into its CSS viewport inside a 5% safe inset (fit below),
// so every text box sits inside the output safe area. CDP receives CSS px, the take stream px.
export const FPS = 60;
export const SAFE = .05;
// The same actions on each layout: the controls they hit and the drag/scroll paths.
export const LANDSCAPE = { design: [2560, 1440], css: [1920, 1080], start: [1500, 900], idle: [1200, 700], newTask: [2300, 44],
  notes: [1280, 650], prio: [1094, 799], high: [1094, 975], create: [1530, 908], grab: [560, 250],
  drop: [1110, 300], feed: [2250, 640], done: [1080, 414], more: [2475, 44], archive: [2350, 166],
  rest: [1300, 760], end: [1600, 1000] };
export const PORTRAIT = { design: [1080, 1920], css: [1080, 1920], start: [640, 1300], idle: [500, 900], newTask: [820, 44],
  notes: [540, 960], prio: [354, 1109], high: [354, 1285], create: [790, 1218], grab: [190, 320],
  drop: [530, 340], feed: [540, 1450], done: [530, 474], more: [995, 44], archive: [870, 166],
  rest: [560, 1000], end: [700, 1400] };
export const SQUARE = { design: [1080, 1080], css: [1080, 1080], start: [640, 700], idle: [500, 500], newTask: [820, 44],
  notes: [540, 540], prio: [354, 689], high: [354, 865], create: [790, 798], grab: [190, 290],
  drop: [530, 310], feed: [540, 920], done: [530, 398], more: [995, 44], archive: [870, 166],
  rest: [560, 600], end: [700, 800] };
export const LAYOUTS = { landscape: LANDSCAPE, portrait: PORTRAIT, square: SQUARE };
/** Design px -> CSS px: the scene's scale and safe-inset origin (scene.html applies the same). */
export const fit = p => ({ s: (1 - 2 * SAFE) * p.css[0] / p.design[0], ox: SAFE * p.css[0], oy: SAFE * p.css[1] });
export function choreography(p = LANDSCAPE) {
  const steps = new Map();
  let frame = 0, [x, y] = p.start;
  const add = action => { if (!steps.has(frame)) steps.set(frame, []); steps.get(frame).push(action); };
  const hold = seconds => { frame += Math.round(seconds * FPS); };
  const move = (nx, ny, seconds = .5) => {
    const x0 = x, y0 = y, n = Math.round(seconds * FPS);
    for (let i = 1; i <= n; i++) {
      frame++; const u = i / n, e = u * u * (3 - 2 * u);
      x = x0 + (nx - x0) * e; y = y0 + (ny - y0) * e;
      add({ k: 'move', x, y });
    }
  };
  const button = down => add({ k: 'button', down, x, y });
  const click = (nx, ny) => { move(nx, ny); hold(.1); button(true); hold(.1); button(false); };
  const type = text => {
    for (const ch of text) { add({ k: 'key', ch, down: true }); frame++; add({ k: 'key', ch, down: false }); frame += 3; }
  };
  const scroll = n => {
    for (let i = 0; i < Math.abs(n); i++) { add({ k: 'wheel', dy: Math.sign(n) * 120, x, y }); hold(.15); }
  };
  add({ k: 'move', x, y }); hold(1.5);
  move(...p.idle); hold(.5);
  click(...p.newTask); hold(.7);
  type('Draft launch announcement'); hold(.5);
  click(...p.notes); hold(.3);
  type('Two short paragraphs and a link to the demo.'); hold(.5);
  click(...p.prio); hold(.5);
  click(...p.high); hold(.5);
  click(...p.create); hold(2.4);
  move(...p.grab); hold(.15); button(true); hold(.12);
  move(p.grab[0] + 12, p.grab[1] + 6, .12); move(...p.drop, 1.5); hold(.2); button(false); hold(2);
  move(...p.feed); scroll(7); hold(.7); scroll(-3); hold(.7);
  for (const [dx, dy] of [[6,3],[-4,5],[3,-6],[-5,-2],[4,4]]) { move(x+dx,y+dy,.1); hold(.25); }
  click(...p.done); hold(1.6);
  click(...p.more); hold(.7); click(...p.archive); hold(2.6);
  move(...p.rest, .9); hold(.7);
  click(...p.newTask); hold(.7); type('Book demo room'); hold(.5);
  click(...p.create); hold(2.4); move(...p.end, .8); hold(2);
  return { steps, frames: frame + 1 };
}
export function inputEvents(steps, frames, p = LANDSCAPE, k = 2) {
  let [x, y] = p.start;
  const { s, ox, oy } = fit(p), rect = [0, 0, p.css[0] * k, p.css[1] * k];
  const events = [{ t: 0, k: 'win', cls: 'headless-demo', title: 'Tidewater board', rect }];
  for (let frame = 0; frame < frames; frame++) {
    const t = frame * 1000 / FPS;
    for (const a of steps.get(frame) ?? []) {
      if (a.k === 'move') { x = a.x; y = a.y; }
    }
    events.push({ t, k: 'ptr', x: (ox + x * s) * k, y: (oy + y * s) * k });
    for (const a of steps.get(frame) ?? []) {
      if (a.k === 'button') events.push({ t, k: 'btn', b: 'left', down: a.down });
      if (a.k === 'wheel') events.push({ t, k: 'wheel', dx: 0, dy: -a.dy });
      if (a.k === 'key') events.push({ t, k: 'key', cls: a.ch === ' ' ? 'space' : 'char', down: a.down });
    }
  }
  return events;
}

// Virtual receive time follows the recorder's monotonic nanosecond field.
export function frameClock(frames) {
  return Array.from({ length: frames }, (_, i) => `${i * 1500}\t${Math.round(i * 1_000_000_000 / FPS)}`).join('\n') + '\n';
}
