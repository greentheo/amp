// The MIDI panel's view of the native app's MIDI map.
//
// In the app, MIDI does not come through the page at all. CoreMIDI feeds
// ampcore::MidiMap (a port of midi.js) inside the app, which moves the amp
// and the pedals directly, so a footswitch works even while macOS has the
// WebView suspended behind other windows. This class gives the panel the
// same surface as Midi — arm, bindings, unbind, the monitor line — by asking
// the app and listening to what it reports back.

import { sourceText } from './midi.js';

export class NativeMidi {
  /**
   * @param {import('./audio/native.js').NativeEngine} engine
   * @param {import('./controls.js').Controls} controls
   * @param {object} h the same handlers Midi takes, plus onNote(text)
   */
  constructor(engine, controls, h = {}) {
    this.engine = engine;
    this.controls = controls;
    this.h = h;
    const saved = (engine.saved && engine.saved.midi) || {};
    this.inputs = saved.inputs || [];
    this.bindings = saved.bindings || [];
    this.armed = null;
    this.count = 0;
    engine.backend.addEventListener('midi', (batch) => {
      for (const item of batch) this.handle(item.kind, item.value);
    });
  }

  get available() { return true; }
  get connected() { return this.inputs.length > 0; }

  /** Always on in the app; this just reports what is connected. */
  async autoEnable() { if (this.h.onStatus) this.h.onStatus(this.inputs); return this.inputs; }
  /** Look for devices again. Hot-plug is automatic; this is the button. */
  async enable() { this.engine.send({ type: 'midiRescan' }); return this.inputs; }

  handle(kind, v) {
    const h = this.h;
    if (kind === 'inputs') {
      this.inputs = v || [];
      if (h.onStatus) h.onStatus(this.inputs);
    } else if (kind === 'activity') {
      this.count = v.count;
      if (h.onActivity) h.onActivity(v.text, v.count, v.device);
    } else if (kind === 'armed') {
      this.armed = v || null;
      if (h.onLearn) h.onLearn(this.armed, null);
    } else if (kind === 'learned') {
      const b = v.binding;
      this.armed = null;
      const also = (v.also || []).map((id) => this.controls.label(id));
      if (h.onLearn) {
        h.onLearn(null, `${this.controls.label(b.id)} ← ${b.device ? `${b.device} ` : ''}${sourceText(b)}`
          + (also.length ? `   (also drives ${also.join(', ')})` : ''));
      }
    } else if (kind === 'refused') {
      if (h.onLearn) h.onLearn(v.id, v.why);
    } else if (kind === 'bindings') {
      this.bindings = v || [];
      if (h.onBindings) h.onBindings();
    } else if (kind === 'catching') {
      if (h.onCatching) h.onCatching(v.id, v.n < 0 ? null : v.n);
    } else if (kind === 'controls') {
      // The app already moved these; the panel only follows, and must not
      // send them back.
      this.engine.quietly(() => {
        for (const c of v) {
          const d = this.controls.get(c.id);
          if (d) this.controls.set(c.id, d.kind === 'switch' ? c.value >= 0.5 : c.value, 'midi');
        }
      });
    } else if (kind === 'note') {
      if (h.onNote) h.onNote(v);
    }
  }

  arm(id) {
    this.armed = id;
    this.engine.send({ type: 'midiArm', id });
    if (this.h.onLearn) this.h.onLearn(id, null);
  }

  disarm() {
    this.armed = null;
    this.engine.send({ type: 'midiDisarm' });
    if (this.h.onLearn) this.h.onLearn(null, null);
  }

  bindingsFor(id) { return this.bindings.filter((b) => b.id === id); }
  unbindControl(id) { this.engine.send({ type: 'midiUnbind', id }); }
  remove(b) { this.bindings = this.bindings.filter((x) => x !== b); this.save(); }
  clear() { this.engine.send({ type: 'midiClear' }); }

  /** A pedal went; so do its bindings. */
  dropPrefix(prefix) {
    const n = this.bindings.filter((b) => b.id.startsWith(prefix)).length;
    if (n) this.engine.send({ type: 'midiDrop', prefix });
    return n;
  }

  /** The table was edited in place (mode, range, takeover): send it all. */
  save() {
    this.engine.send({ type: 'midiBindings', bindings: this.bindings });
    return true;
  }
}
