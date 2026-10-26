// Web MIDI: any control on the page, from any knob, fader, expression pedal
// or footswitch.
//
// The shape is the one the ambient app arrived at after finding most of the
// ways this goes wrong, adapted from "eight knobs drive the selected track"
// to "anything can be bound to anything": an amp and a pedalboard are a
// flat set of distinct controls, not a mixer with a selection.
//
//   learn      click a control in map mode, then touch the hardware
//   knobs      absolute (with soft takeover) or relative encoders
//   switches   toggle on each press, or follow a latching switch
//   ranges     an expression pedal can sweep part of a control, not all
//
// What came across from ambient, because each one was learned the hard way:
//
//   device scoping — two controllers happily send the same CC, so a binding
//     remembers which surface it came from
//   soft takeover — an absolute knob stays inert until it crosses the value
//     it is about to take over, or loading a preset makes everything jump
//   auto-reconnect — if MIDI was granted before, rebind silently on load,
//     or the saved mapping is displayed while nothing is listening
//   hot-plug — onstatechange rebinds, so plugging in after load works
//   the monitor line — the first diagnostic: if it stays blank while you
//     move a knob, nothing is reaching the page and no mapping will help

const STORE = 'amp.midi.v1';
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function describe(status, ch, a, b) {
  const c = `ch${ch + 1}`;
  if (status === 0xb0) return `CC ${a} = ${b}  (${c})`;
  if (status === 0x90 && b > 0) return `note on ${NOTES[a % 12]}${Math.floor(a / 12) - 1} (${a}) vel ${b}  (${c})`;
  if (status === 0x80 || status === 0x90) return `note off ${NOTES[a % 12]}${Math.floor(a / 12) - 1} (${a})  (${c})`;
  if (status === 0xc0) return `program change ${a}  (${c})`;
  if (status === 0xe0) return `pitch bend  (${c})`;
  return `status 0x${status.toString(16)} ${a} ${b}  (${c})`;
}

/** "CC 21" / "N 36", for badges. */
export function sourceText(b) {
  return `${b.kind === 'cc' ? 'CC' : 'N'} ${b.num}`;
}

export class Midi {
  /**
   * @param {import('./controls.js').Controls} controls
   * @param {object} h onStatus, onActivity, onLearn, onBindings, onCatching
   */
  constructor(controls, h = {}) {
    this.controls = controls;
    this.h = h;
    this.access = null;
    this.inputs = [];
    this.bindings = [];
    this.armed = null;               // control id waiting for a source
    this.count = 0;
    this.state = new WeakMap();      // binding -> { engaged, last }
    this.detect = null;              // switch learn: momentary or latching?
    this.load();

    // Something other than this binding moved the control, so the hardware
    // knob is no longer where the value is. It must catch up before it is
    // allowed to drive again.
    controls.on((kind, id, source) => {
      if (kind !== 'change') return;
      for (const b of this.bindings) {
        if (b.id !== id || source === b) continue;
        const st = this.state.get(b);
        if (st) st.engaged = false;
      }
    });
  }

  get available() { return typeof navigator.requestMIDIAccess === 'function'; }
  get connected() { return !!this.access && this.inputs.length > 0; }

  /* ---------------- connection ---------------- */

  async autoEnable() {
    if (!this.available) return null;
    try {
      const st = await navigator.permissions.query({ name: 'midi', sysex: false });
      if (st.state !== 'granted') return null;
    } catch { return null; }
    return this.enable();
  }

  async enable() {
    if (!this.available) throw new Error('Web MIDI is not available in this browser');
    this.access = await navigator.requestMIDIAccess({ sysex: false });
    const bind = () => {
      const names = [];
      for (const inp of this.access.inputs.values()) {
        inp.onmidimessage = (e) => this.onMessage(e.data, inp.name);
        names.push(inp.name);
      }
      this.inputs = names;
      if (this.h.onStatus) this.h.onStatus(names);
    };
    bind();
    this.access.onstatechange = bind;
    return this.inputs;
  }

  /* ---------------- learning ---------------- */

  arm(id) {
    this.armed = id;
    if (this.h.onLearn) this.h.onLearn(id, null);
  }

  disarm() {
    this.armed = null;
    if (this.h.onLearn) this.h.onLearn(null, null);
  }

  learn(id, kind, num, ch, device, value) {
    const c = this.controls.get(id);
    if (!c) { this.disarm(); return; }
    const isSwitch = c.kind === 'switch';

    if (!isSwitch && kind === 'note') {
      if (this.h.onLearn) {
        this.h.onLearn(id, `That was a note. A knob needs a knob, fader or expression pedal — `
          + `move one, or arm a footswitch target instead.`);
      }
      return;
    }

    // One source per control: learning again replaces it. A single physical
    // control may still drive several targets — a footswitch that brings in
    // a boost and a delay together is a solo button, and a knob on two
    // parameters is a macro — so it is reported rather than stolen.
    this.bindings = this.bindings.filter((b) => b.id !== id);
    const b = {
      id, device, ch, kind, num,
      mode: isSwitch ? 'toggle' : 'absolute',
      lo: 0, hi: 1, takeover: true,
    };
    this.bindings.push(b);
    this.state.set(b, { engaged: true, last: value / 127 });

    const also = this.bindings
      .filter((o) => o !== b && o.kind === kind && o.num === num && o.ch === ch
        && (!o.device || !device || o.device === device))
      .map((o) => this.controls.label(o.id));

    // A footswitch on a CC is either momentary — 127 on press, 0 on release —
    // or latching, alternating 127 and 0 on successive presses. They need
    // opposite handling, and there is no way to tell from one message. So
    // watch for a release: one within 600 ms means momentary, toggle on each
    // press; none means latching, follow the value.
    if (isSwitch && kind === 'cc') {
      this.detect = { b, released: false };
      setTimeout(() => {
        if (!this.detect || this.detect.b !== b) return;
        b.mode = this.detect.released ? 'toggle' : 'follow';
        this.detect = null;
        this.save();
        if (this.h.onBindings) this.h.onBindings();
      }, 600);
    }

    this.armed = null;
    this.save();
    if (this.h.onLearn) {
      this.h.onLearn(null, `${this.controls.label(id)} ← ${device ? `${device} ` : ''}${sourceText(b)}`
        + (also.length ? `   (also drives ${also.join(', ')})` : ''));
    }
    if (this.h.onBindings) this.h.onBindings();
  }

  /* ---------------- incoming ---------------- */

  onMessage(data, device = '') {
    const status = data[0] & 0xf0;
    const ch = data[0] & 0x0f;
    const a = data[1], v = data[2];
    this.count++;
    if (this.h.onActivity) this.h.onActivity(describe(status, ch, a, v), this.count, device);

    let kind, value;
    if (status === 0xb0) { kind = 'cc'; value = v; }
    else if (status === 0x90 && v > 0) { kind = 'note'; value = 127; }
    else if (status === 0x80 || status === 0x90) { kind = 'note'; value = 0; }
    else return;                      // program change etc: not bound yet

    if (this.detect && kind === 'cc' && this.detect.b.num === a && this.detect.b.ch === ch && value < 64) {
      this.detect.released = true;
    }

    if (this.armed) {
      // A note-off is the tail of the press that was already learned, not a
      // new control; ignore it rather than relearning on release.
      if (kind === 'note' && value === 0) return;
      return this.learn(this.armed, kind, a, ch, device, value);
    }

    for (const b of this.bindings) {
      if (b.kind !== kind || b.num !== a || b.ch !== ch) continue;
      // Scoped to another device — unless that device is not connected at
      // all, which usually means the same controller under another name (a
      // map from another machine, or the native app, which names devices
      // through CoreMIDI rather than the browser).
      if (b.device && device && b.device !== device && this.inputs.includes(b.device)) continue;
      this.apply(b, value);
    }
  }

  apply(b, value) {
    const c = this.controls.get(b.id);
    if (!c) return;
    const st = this.state.get(b) || { engaged: false, last: null };
    this.state.set(b, st);

    if (c.kind === 'switch') {
      const down = value >= 64;
      if (b.mode === 'follow') {
        this.controls.set(b.id, down, b);
      } else if (down && !(st.last >= 0.5)) {
        // Toggle on the press only. A momentary switch sends a release too,
        // and acting on that would switch the pedal straight back.
        this.controls.toggle(b.id, b);
      }
      st.last = value / 127;
      return;
    }

    if (b.mode === 'relative') {
      // Two's complement, the common encoding: 1..63 up, 127..65 down.
      const delta = value < 64 ? value : value - 128;
      this.controls.setNorm(b.id, this.controls.norm(b.id) + delta / 127, b);
      return;
    }

    // Absolute, mapped into this binding's slice of the control's range.
    const n = b.lo + (value / 127) * (b.hi - b.lo);
    if (b.takeover && !st.engaged) {
      const cur = this.controls.norm(b.id);
      const crossed = st.last != null && (st.last - cur) * (n - cur) <= 0;
      if (crossed || Math.abs(n - cur) < 0.03) st.engaged = true;
      st.last = n;
      if (this.h.onCatching) this.h.onCatching(b.id, st.engaged ? null : n);
      if (!st.engaged) return;
    }
    st.last = n;
    st.engaged = true;
    this.controls.setNorm(b.id, n, b);
  }

  /* ---------------- managing ---------------- */

  bindingsFor(id) { return this.bindings.filter((b) => b.id === id); }

  unbindControl(id) {
    this.bindings = this.bindings.filter((b) => b.id !== id);
    this.save();
    if (this.h.onBindings) this.h.onBindings();
  }

  remove(b) {
    this.bindings = this.bindings.filter((x) => x !== b);
    this.save();
    if (this.h.onBindings) this.h.onBindings();
  }

  /** A pedal went; so do its bindings. */
  dropPrefix(prefix) {
    const before = this.bindings.length;
    this.bindings = this.bindings.filter((b) => !b.id.startsWith(prefix));
    if (this.bindings.length !== before) {
      this.save();
      if (this.h.onBindings) this.h.onBindings();
    }
    return before - this.bindings.length;
  }

  clear() {
    this.bindings = [];
    this.save();
    if (this.h.onBindings) this.h.onBindings();
  }

  save() {
    try {
      localStorage.setItem(STORE, JSON.stringify(this.bindings));
      return true;
    } catch { return false; }
  }

  load() {
    try {
      const raw = localStorage.getItem(STORE);
      if (raw) this.bindings = JSON.parse(raw).filter((b) => b && b.id && b.kind);
    } catch { this.bindings = []; }
  }

  toPreset() {
    return JSON.stringify({ format: 'amp-midi-map', version: 1, bindings: this.bindings }, null, 2);
  }

  fromPreset(text) {
    const d = JSON.parse(text);
    if (d.format !== 'amp-midi-map') throw new Error('not an Amp MIDI map');
    this.bindings = (d.bindings || []).filter((b) => b && b.id && b.kind);
    this.save();
    if (this.h.onBindings) this.h.onBindings();
    return this.bindings.length;
  }
}
