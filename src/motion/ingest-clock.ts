// Page timers advance only through explicit ingest waits; Chromium's compositor keeps its real frame clock.
// Pausing CDP virtual time also pauses paint after DOM mutations, so screenshot requests can hang.
export const INGEST_CLOCK = `(() => {
  let now = 0, sequence = 0;
  const timers = new Map();
  const schedule = (fn, delay, repeat, args) => {
    const id = ++sequence, ms = Math.max(repeat ? 1 : 0, Number(delay) || 0);
    timers.set(id, { fn, at: now + ms, repeat: repeat ? ms : 0, args });
    return id;
  };
  window.setTimeout = (fn, ms, ...args) => schedule(fn, ms, false, args);
  window.setInterval = (fn, ms, ...args) => schedule(fn, ms, true, args);
  window.clearTimeout = window.clearInterval = id => timers.delete(id);
  const NativeDate = Date, epoch = 946684800000;
  const clockNow = () => epoch + now;
  window.Date = new Proxy(NativeDate, {
    apply() { return new NativeDate(clockNow()).toString(); },
    construct(target, args, newTarget) { return Reflect.construct(target, args.length ? args : [clockNow()], newTarget); },
    get(target, property, receiver) { return property === 'now' ? clockNow : Reflect.get(target, property, receiver); },
  });
  Object.defineProperty(performance, 'now', { value: () => now });
  window.__advanceIngest = async ms => {
    const end = now + ms;
    for (let count = 0; ; count++) {
      if (count > 10000) throw new Error('ingest timer loop exceeds budget');
      const due = [...timers].filter(([,t]) => t.at <= end).sort((a,b) => a[1].at-b[1].at || a[0]-b[0])[0];
      if (!due) break;
      const [id, timer] = due; now = timer.at;
      if (timer.repeat) timer.at += timer.repeat; else timers.delete(id);
      if (typeof timer.fn === 'function') timer.fn(...timer.args); else (0,eval)(String(timer.fn));
      await Promise.resolve();
    }
    now = end;
  };
})();`;
