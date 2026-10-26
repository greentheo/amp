// Does the tuner read the right note, and do both builds read the same one?
//
//   node tools/tuner-parity.mjs
//
// Synthesises notes across the range a tuner meets — sines, plucked strings
// with a strong second harmonic, a little stiffness and some noise, notes
// tuned off by a known amount, the low B of a 5-string bass — at three
// sample rates, and runs each through js/audio/tuner.js and through ampcore
// (ampcore-test tuner). Reports how far the reading is from the truth, in
// cents, and whether the two builds agree to the last bit. Then the same for
// the DI recording, where there is no truth to compare with, only parity.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PitchDetector, hzOf } from '../js/audio/tuner.js';
import { readWav, mono } from './lib/wavio.mjs';

const BIN = new URL('../native/ampcore/build/ampcore-test', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'tuner-'));

let seed = 0x7e57;
const rand = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** A plucked string: partials k·f·sqrt(1 + B·k²), the second loudest, each
 *  dying faster than the last, plus noise. B = 0 and one partial is a sine. */
function note(rate, hz, { secs = 1.2, partials = 12, stiff = 0, noise = 0, decay = 1.5 } = {}) {
  const n = Math.round(rate * secs);
  const x = new Float32Array(n);
  for (let k = 1; k <= partials; k++) {
    const f = k * hz * Math.sqrt(1 + stiff * k * k);
    if (f > rate * 0.45) break;
    const amp = (k === 2 ? 1.4 : 1) / k;
    const ph = rand() * 2 * Math.PI;
    const dk = decay * (1 + 0.4 * k);
    for (let i = 0; i < n; i++) x[i] += amp * Math.exp((-dk * i) / rate) * Math.sin((2 * Math.PI * f * i) / rate + ph);
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(x[i]));
  for (let i = 0; i < n; i++) x[i] = (x[i] / peak) * 0.3 + noise * (rand() * 2 - 1);
  return x;
}

/** Both builds' readings, one per hop: [{hz, clarity, rms}], and whether
 *  they matched exactly. */
function readBoth(rate, x, hop) {
  const det = new PitchDetector(rate);
  const js = [];
  for (let end = det.window(); end <= x.length; end += hop) js.push(det.analyse(x.subarray(0, end)));
  const file = join(dir, 'in.f32');
  writeFileSync(file, Buffer.from(x.buffer, x.byteOffset, x.byteLength));
  const out = execFileSync(BIN, ['tuner', String(rate), file, String(hop)], { encoding: 'utf8' }).trim().split('\n');
  let same = out.length === js.length;
  for (let i = 0; same && i < js.length; i++) {
    const [hz, clarity, rms] = out[i].split(' ').map(Number);
    same = hz === js[i].hz && clarity === js[i].clarity && rms === js[i].rms;
  }
  return { js, same };
}

// A bass's bottom strings get the second, looser limit below: the window
// holds barely more than one of their cycles.
const STRINGS = [
  ['B0 (5-string bass)', 23, true], ['E1 (bass)', 28, true], ['B1 (7-string)', 35], ['D2 (drop D)', 38],
  ['E2', 40], ['A2', 45], ['D3', 50], ['G3', 55], ['B3', 59], ['E4', 64],
  ['E5 (12th fret)', 76], ['E6 (24th fret)', 88],
];
// Each kind with the worst single look it may give, in cents, on a guitar
// and on a bass. A stiff
// string's partials really are sharp of its fundamental, and the reading
// follows them a little, as any tuner's does; the noisy one has hiss at
// -40 dB below the pluck, far more than a guitar lead carries.
const CASES = [
  ['sine', { partials: 1 }, 0.1, 1],
  ['string', {}, 0.5, 1],
  ['stiff string', { stiff: 0.00008 }, 2, 2.5],
  ['stiff string, noisy', { stiff: 0.00008, noise: 0.003 }, 3, 4],
];

let octave = 0, silent = 0, mismatched = 0, looks = 0, over = 0;
const worstOf = {};
const rows = [];
for (const rate of [44100, 48000, 96000]) {
  for (const [label, midi, bass] of STRINGS) {
    for (const off of [0, -13.7, 21.3]) {
      const hz = hzOf(midi + off / 100);
      for (const [kind, o, guitarLimit, bassLimit] of CASES) {
        const limit = bass ? bassLimit : guitarLimit;
        const x = note(rate, hz, o);
        const { js, same } = readBoth(rate, x, Math.round(rate / 30));
        if (!same) mismatched++;
        // Past the attack, every look should find the note.
        const settled = js.slice(3);
        let err = 0, miss = 0;
        for (const p of settled) {
          looks++;
          if (!p.hz || p.clarity < 0.85) { miss++; continue; }
          const c = 1200 * Math.log2(p.hz / hz);
          if (Math.abs(c) > 600) { octave++; continue; }
          err = Math.max(err, Math.abs(c));
        }
        silent += miss;
        const key = `${kind}${bass ? ' (bass)' : ''}`;
        worstOf[key] = Math.max(worstOf[key] || 0, err);
        if (err > limit) over++;
        if (err > limit || miss || !same) rows.push(`${rate} ${label} ${off >= 0 ? '+' : ''}${off}c ${kind}: worst ${err.toFixed(3)} c, ${miss} missed${same ? '' : ', BUILDS DIFFER'}`);
      }
    }
  }
}
for (const r of rows) console.log(r);
for (const [kind, , g, b] of CASES) {
  console.log(`${kind}: worst ${worstOf[kind].toFixed(3)} cents (limit ${g}); on a bass ${worstOf[`${kind} (bass)`].toFixed(3)} (limit ${b})`);
}
console.log(`synthetic: ${looks} looks, ${octave} octave errors, ${silent} missed, ${mismatched} cases where the builds differ`);

const DI = new URL('../calibration/di/freepats-cc0-reference.wav', import.meta.url).pathname;
if (existsSync(DI)) {
  const w = readWav(DI);
  const x = Float32Array.from(mono(w));
  const { js, same } = readBoth(w.rate, x, 1600);
  const voiced = js.filter((p) => p.hz && p.clarity >= 0.85).length;
  console.log(`DI recording: ${js.length} looks, ${voiced} with a note, builds ${same ? 'identical' : 'DIFFER'}`);
  if (!same) mismatched++;
}
process.exit(over || octave || silent || mismatched ? 1 : 0);
