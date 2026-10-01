// Injected before scene scripts. Nothing advances with wall time.
(() => {
  let now = 0, nextId = 0;
  const timers = new Map(), rafs = new Map(), animations = new WeakMap();
  const NativeDate = Date;
  window.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [Date.UTC(2026, 0, 1) + now])); }
    static now() { return NativeDate.UTC(2026, 0, 1) + now; }
  };
  Object.defineProperty(performance, 'now', { value: () => now });
  window.setTimeout = (fn, delay = 0, ...args) => {
    const id = ++nextId;
    timers.set(id, { at: now + Math.max(0, Number(delay) || 0), fn, args });
    return id;
  };
  window.clearTimeout = id => timers.delete(id);
  window.requestAnimationFrame = fn => { const id = ++nextId; rafs.set(id, fn); return id; };
  window.cancelAnimationFrame = id => rafs.delete(id);
  window.__takeoneTick = t => {
    if (t < now) throw new Error('Virtual clock cannot go backwards');
    let fired = 0;
    while (true) {
      const due = [...timers].filter(([, v]) => v.at <= t).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      if (++fired > 10000) throw new Error('Virtual timer loop');
      timers.delete(due[0]); now = due[1].at;
      due[1].fn(...due[1].args);
    }
    now = t;
    const callbacks = [...rafs.values()]; rafs.clear(); callbacks.forEach(fn => fn(t));
  };
  window.__takeonePaint = () => {
    // Flush style so newly inserted cards have animations before taking a frame.
    document.body.getBoundingClientRect();
    for (const animation of document.getAnimations()) {
      if (!animations.has(animation)) { animations.set(animation, now); animation.pause(); }
      animation.currentTime = now - animations.get(animation);
    }
  };
})();
