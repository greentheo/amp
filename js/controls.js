// Every control on the page, in one place, under one stable id.
//
//   amp.drive            a knob on the amp
//   amp.stages           a stepped control
//   pedal.<uid>.drive    a knob on a pedal
//   pedal.<uid>.on       a footswitch
//
// The point is that nothing else has to know what a control belongs to. The
// MIDI layer binds a CC to an id; the UI paints whatever changed; a preset
// is a list of ids and values. A pedal learned from a recording of a real
// one will register knobs here with whatever names its owner gave them, and
// MIDI will map to them without a line changing.
//
// Every change carries a `source`. That is what soft takeover runs on: a MIDI
// knob that last set a value is still "holding" it, but the moment anything
// else moves that control — a mouse, another binding, a preset — the
// hardware knob is no longer where the value is, and it must not jump the
// control back the next time it twitches.

export class Controls {
  constructor() {
    this.map = new Map();
    this.subs = new Set();
  }

  /**
   * @param {object} def id, label, group, kind ('knob'|'switch'|'step'),
   *   min, max, step?, get(), set(v), fmt?(v)
   */
  register(def) {
    const d = { kind: 'knob', min: 0, max: 1, group: '', ...def };
    this.map.set(d.id, d);
    this.emit('add', d.id);
    return d;
  }

  /** Drop every control whose id starts with `prefix` — a removed pedal. */
  unregister(prefix) {
    for (const id of [...this.map.keys()]) {
      if (id === prefix || id.startsWith(prefix)) {
        this.map.delete(id);
        this.emit('remove', id);
      }
    }
  }

  has(id) { return this.map.has(id); }
  get(id) { return this.map.get(id); }
  all() { return [...this.map.values()]; }

  value(id) {
    const d = this.map.get(id);
    return d ? d.get() : undefined;
  }

  /** Position in 0..1, which is what a CC and a knob's dial both speak. */
  norm(id) {
    const d = this.map.get(id);
    if (!d) return 0;
    if (d.kind === 'switch') return d.get() ? 1 : 0;
    return (d.get() - d.min) / (d.max - d.min || 1);
  }

  set(id, v, source = 'ui') {
    const d = this.map.get(id);
    if (!d) return;
    let x = d.kind === 'switch' ? !!v : Math.min(d.max, Math.max(d.min, +v));
    if (d.kind === 'step' || d.step) {
      const st = d.step || 1;
      x = d.min + Math.round((x - d.min) / st) * st;
    }
    if (d.kind !== 'switch' && x === d.get()) return;
    if (d.kind === 'switch' && x === !!d.get()) return;
    d.set(x);
    this.emit('change', id, source);
  }

  setNorm(id, n, source) {
    const d = this.map.get(id);
    if (!d) return;
    if (d.kind === 'switch') return this.set(id, n >= 0.5, source);
    this.set(id, d.min + Math.min(1, Math.max(0, n)) * (d.max - d.min), source);
  }

  toggle(id, source) { this.set(id, !this.value(id), source); }

  /** Label for lists and status lines: "Overdrive · Drive". */
  label(id) {
    const d = this.map.get(id);
    if (!d) return id;
    return d.group ? `${d.group} · ${d.label}` : d.label;
  }

  display(id) {
    const d = this.map.get(id);
    if (!d) return '';
    const v = d.get();
    if (d.fmt) return d.fmt(v);
    if (d.kind === 'switch') return v ? 'on' : 'off';
    return String(Math.round(this.norm(id) * 10));
  }

  on(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  emit(kind, id, source) {
    for (const fn of this.subs) {
      try { fn(kind, id, source); } catch (e) { console.error(e); }
    }
  }
}

export const controls = new Controls();
