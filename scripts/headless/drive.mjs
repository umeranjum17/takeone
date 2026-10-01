// The board choreography in frame numbers. Coordinates use the original scene's
// 2560x1440 layout; CDP receives CSS pixels and the take receives stream pixels.
export const FPS = 60;
export const CSS_SCALE = .75;
export function choreography() {
  const steps = new Map();
  let frame = 0, x = 1500, y = 900;
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
  move(1200, 700); hold(.5);
  click(2300, 44); hold(.7);
  type('Draft launch announcement'); hold(.5);
  click(1280, 650); hold(.3);
  type('Two short paragraphs and a link to the demo.'); hold(.5);
  click(1094, 799); hold(.5);
  click(1094, 975); hold(.5);
  click(1530, 908); hold(2.4);
  move(560, 250); hold(.15); button(true); hold(.12);
  move(572, 256, .12); move(1110, 300, 1.5); hold(.2); button(false); hold(2);
  move(2250, 640); scroll(7); hold(.7); scroll(-3); hold(.7);
  for (const [dx, dy] of [[6,3],[-4,5],[3,-6],[-5,-2],[4,4]]) { move(x+dx,y+dy,.1); hold(.25); }
  click(1080, 414); hold(1.6);
  click(2475, 44); hold(.7); click(2350, 166); hold(2.6);
  move(1300, 760, .9); hold(.7);
  click(2300, 44); hold(.7); type('Book demo room'); hold(.5);
  click(1530, 908); hold(2.4); move(1600, 1000, .8); hold(2);
  return { steps, frames: frame + 1 };
}
export function inputEvents(steps, frames) {
  let x = 1500, y = 900;
  const events = [{ t: 0, k: 'win', cls: 'headless-demo', title: 'Tidewater board', rect: [0,0,3840,2160] }];
  for (let frame = 0; frame < frames; frame++) {
    const t = frame * 1000 / FPS;
    for (const a of steps.get(frame) ?? []) {
      if (a.k === 'move') { x = a.x; y = a.y; }
    }
    events.push({ t, k: 'ptr', x: x * CSS_SCALE * 2, y: y * CSS_SCALE * 2 });
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
