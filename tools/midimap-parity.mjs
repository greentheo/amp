// Is the native MIDI map the same as the browser's?
//
//   node tools/midimap-parity.mjs
//
// Runs one scripted session — learning knobs, a stepped control and both
// kinds of footswitch, soft takeover after the page moves a knob, relative
// encoders, ranges, a refused note, device scoping, a deleted pedal —
// through js/midi.js (with a fake clock for its 600 ms footswitch test) and
// through ampcore's MidiMap (ampcore-test midimap), and compares every
// control change and the bindings left at the end.

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A fake clock for midi.js's setTimeout, installed before it loads.
let now = 0;
let timers = [];
globalThis.setTimeout = (fn, ms) => { timers.push({ due: now + ms / 1000, fn }); return timers.length; };
const advance = (t) => {
  for (;;) {
    timers.sort((a, b) => a.due - b.due);
    const next = timers[0];
    if (!next || next.due > t) break;
    timers.shift();
    now = next.due;
    next.fn();
  }
  now = t;
};

const { Controls } = await import('../js/controls.js');
const { Midi } = await import('../js/midi.js');

const CONTROLS = [
  { id: 'amp.drive', kind: 'knob', min: 0, max: 1, value: 0.55 },
  { id: 'amp.bias', kind: 'knob', min: -0.5, max: 0.5, value: 0 },
  { id: 'amp.stages', kind: 'step', min: 1, max: 4, step: 1, value: 3 },
  { id: 'pedal.p1.on', kind: 'switch', min: 0, max: 1, value: 0 },
  { id: 'pedal.p1.level', kind: 'knob', min: 0, max: 1, value: 0.5 },
  { id: 'pedal.p2.on', kind: 'switch', min: 0, max: 1, value: 1 },
];

const cc = (n, v, ch = 0) => [0xb0 | ch, n, v];
const on = (n, v = 100) => [0x90, n, v];
const off = (n) => [0x80, n, 0];
const E = [];
let t = 0;
const at = (dt, e) => { t += dt; E.push({ t: +t.toFixed(4), ...e }); };
const msg = (data, device = 'X') => at(0.01, { op: 'msg', data, device });

at(0, { op: 'inputs', names: ['X', 'Y'] });
// A knob, learned, then swept.
at(0.1, { op: 'arm', id: 'amp.drive' });
msg(cc(21, 64));
for (const v of [70, 90, 127, 30, 0]) msg(cc(21, v));
// The page moves it: the knob has to come back to it before it drives.
// The hardware is at 0 and the page sets 0.9, so the next few moves stay
// below it and do nothing; the one that passes 0.9 takes over.
at(0.1, { op: 'touch', id: 'amp.drive', value: 0.9 });
for (const v of [10, 30, 60, 100, 120, 127, 90]) msg(cc(21, v));
// A momentary footswitch: press and release within 600 ms.
at(0.1, { op: 'arm', id: 'pedal.p1.on' });
msg(cc(64, 127)); msg(cc(64, 0));
at(0.8, { op: 'tick' });
for (const v of [127, 0, 127, 0]) msg(cc(64, v));
// A latching one: no release.
at(0.1, { op: 'arm', id: 'pedal.p2.on' });
msg(cc(65, 127));
at(0.8, { op: 'tick' });
for (const v of [0, 127, 0]) msg(cc(65, v));
// A stepped control.
at(0.1, { op: 'arm', id: 'amp.stages' });
msg(cc(22, 10));
for (const v of [0, 40, 64, 100, 127]) msg(cc(22, v));
// A relative encoder.
at(0.1, { op: 'arm', id: 'amp.bias' });
msg(cc(23, 64));
at(0.1, { op: 'edit', id: 'amp.bias', set: { mode: 'relative' } });
for (const v of [1, 1, 3, 127, 125, 10]) msg(cc(23, v));
// A note on a knob is refused; a CC then learns, and gets a range.
at(0.1, { op: 'arm', id: 'pedal.p1.level' });
msg(on(36)); msg(off(36));
msg(cc(24, 0));
at(0.1, { op: 'edit', id: 'pedal.p1.level', set: { lo: 0.2, hi: 0.6, takeover: false } });
for (const v of [0, 64, 127]) msg(cc(24, v));
// A footswitch on a note.
at(0.1, { op: 'arm', id: 'pedal.p1.on' });
msg(on(40)); msg(off(40));
for (const d of [on(40), off(40), on(40), off(40)]) msg(d);
// Device scoping: another controller sending the same CC is ignored...
msg(cc(21, 127), 'Y');
// ...unless the binding's own device is not connected at all.
at(0.1, { op: 'inputs', names: ['Y'] });
msg(cc(21, 127), 'Y');
// A pedal is deleted: its bindings go.
at(0.1, { op: 'drop', prefix: 'pedal.p2.' });
msg(cc(65, 127));
// Program change: shown, not bound.
msg([0xc0, 5]);

// ---- the browser's map ----
const store = Object.fromEntries(CONTROLS.map((c) => [c.id, c.kind === 'switch' ? !!c.value : c.value]));
const controls = new Controls();
for (const c of CONTROLS) {
  controls.register({ id: c.id, label: c.id, kind: c.kind, min: c.min, max: c.max, step: c.step,
    get: () => store[c.id], set: (v) => { store[c.id] = v; } });
}
const jsChanges = [];
controls.on((kind, id, source) => {
  if (kind === 'change' && source && typeof source === 'object') jsChanges.push([id, +store[id]]);
});
const midi = new Midi(controls, {});
midi.bindings = [];
for (const e of E) {
  advance(e.t);
  if (e.op === 'inputs') midi.inputs = e.names;
  else if (e.op === 'arm') midi.arm(e.id);
  else if (e.op === 'msg') midi.onMessage(e.data, e.device);
  else if (e.op === 'touch') controls.set(e.id, e.value, 'test');
  else if (e.op === 'edit') { Object.assign(midi.bindings.find((b) => b.id === e.id), e.set); midi.save(); }
  else if (e.op === 'drop') midi.dropPrefix(e.prefix);
}
const pick = (b) => ({ id: b.id, device: b.device, ch: b.ch, kind: b.kind, num: b.num, mode: b.mode, lo: b.lo, hi: b.hi, takeover: b.takeover });
const jsBindings = midi.bindings.map(pick);

// ---- the native map ----
const dir = mkdtempSync(join(tmpdir(), 'midimap-'));
const file = join(dir, 'scenario.json');
writeFileSync(file, JSON.stringify({ controls: CONTROLS, events: E }));
const out = JSON.parse(execFileSync('native/ampcore/build/ampcore-test', ['midimap', file], { encoding: 'utf8' }));
const ccBindings = out.bindings.map(pick);

// ---- compare ----
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let ok = true;
const n = Math.max(jsChanges.length, out.changes.length);
for (let i = 0; i < n; i++) {
  if (!same(jsChanges[i], out.changes[i])) {
    console.log(`  change ${i}: browser ${JSON.stringify(jsChanges[i])}  native ${JSON.stringify(out.changes[i])}`);
    ok = false;
  }
}
if (!same(jsBindings, ccBindings)) {
  console.log('  bindings differ:\n    browser', JSON.stringify(jsBindings), '\n    native ', JSON.stringify(ccBindings));
  ok = false;
}
console.log(`${E.length} events, ${jsChanges.length} control changes, ${jsBindings.length} bindings left`);
console.log(ok ? 'SAME — the native map does what the browser map does' : 'DIFFERENT');
process.exit(ok ? 0 : 1);
