// Compare two recordings of the same stimulus and say where they differ, in
// terms that point at a block of the amp.
//
//   node tools/compare.mjs <ours.wav> <reference.wav>
//
// The diagnostic value is in *which* measurement is off:
//
//   a broad tilt across the spectrum        the cab
//   a bump or scoop in one region           the tone stack
//   right spectrum, wrong harmonic ratios   the preamp
//   right harmonics, wrong decay            sag and the power supply
//
// Neither recording has to start at the same moment or sit at the same
// level — both are solved for — and they do not even have to share a sample
// rate, because every offset here is held in seconds.

import { readFileSync } from 'node:fs';
import { readWav, mono } from './lib/wavio.mjs';
import { alignByEnvelope, bands, harmonics, envelope, rms, db, THIRD_OCTAVE } from './lib/dsp.mjs';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
if (args.length < 2) {
  console.error('usage: node tools/compare.mjs <ours.wav> <reference.wav> [--stimulus calibration/stimulus.wav]');
  process.exit(2);
}
const manifest = JSON.parse(readFileSync('calibration/stimulus.json', 'utf8'));

/** Load a capture and work out where the stimulus starts inside it. */
function load(path, stim, stimRate) {
  const wav = readWav(path);
  const x = mono(wav);
  // Both rates go in, and the offset comes back in seconds. Everything
  // downstream works in seconds for the same reason: a capture does not
  // have to share a sample rate with anything else here.
  // The marker exists to be aligned on; hand it over rather than trusting
  // the whole file's envelope, which the long sweeps flatten.
  const m = manifest.sections.find((sec) => sec.name === 'marker');
  const { shift, score } = alignByEnvelope(stim, stimRate, x, wav.rate, 10,
    m ? { start: m.start, seconds: m.seconds } : null);

  // Align a second time on something near the end. If the capture runs at
  // the right speed those two offsets agree; if it has been time-stretched
  // they do not, and they drift apart in proportion to the error.
  //
  // This is worth the second pass because of one specific and very easy
  // mistake: Ableton auto-warps long imports, and a warped clip is
  // time-stretched. Every section then lands somewhere other than where the
  // manifest says, and the report comes out detailed, confident and
  // meaningless. Catching it costs a correlation; not catching it costs an
  // afternoon.
  let drift = null;
  const late = [...manifest.sections].reverse()
    .find((sec) => sec.name === 'decay' || sec.name.startsWith('di-') || sec.name === 'musical-synth');
  if (late) {
    const l = alignByEnvelope(stim, stimRate, x, wav.rate, 10,
      { start: late.start, seconds: Math.min(late.seconds, 4) });
    if (l.score > 0.2) drift = { secs: l.shift - shift, over: late.start - (m ? m.start : 0) };
  }
  return { path, x, rate: wav.rate, offset: shift, score, frames: wav.frames, drift };
}

const section = (name) => manifest.sections.find((s) => s.name === name);

/** Samples of one named section out of a capture. */
function slice(cap, name, { trimStart = 0, trimEnd = 0 } = {}) {
  const s = section(name);
  const from = Math.round((cap.offset + s.start + trimStart) * cap.rate);
  const len = Math.round((s.seconds - trimStart - trimEnd) * cap.rate);
  if (from < 0 || from + len > cap.x.length) return null;
  return { from, len };
}

const stimWav = readWav('calibration/stimulus.wav');
const stim = mono(stimWav);

const ours = load(args[0], stim, stimWav.rate);
const ref = load(args[1], stim, stimWav.rate);

const JSON_OUT = flags.has('--json');
const metrics = { ours: args[0], reference: args[1] };
// --json turns the report into something a tuning loop can rank on. The
// printed version stays exactly as it was: a score is for searching, and a
// human still has to look at which band is wrong and why.
const say = (...a) => { if (!JSON_OUT) console.log(...a); };

const pad = (s, n) => String(s).padStart(n);
const sign = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
let worst = [];

say(`\n  ours       ${ours.path}`);
say(`  reference  ${ref.path}\n`);
for (const c of [ours, ref]) {
  const warn = c.score < 0.3 ? '   <-- weak, check this capture' : '';
  say(`  ${c.path.split('/').pop().padEnd(28)} ${(c.frames / c.rate).toFixed(1)} s @ ${c.rate / 1000} kHz` +
    `   aligned ${c.offset >= 0 ? '+' : ''}${c.offset.toFixed(3)} s   corr ${c.score.toFixed(2)}${warn}`);
}
if (ours.score < 0.3 || ref.score < 0.3) {
  say('\n  A low correlation means the stimulus was not found. Usually the capture');
  say('  is of something else, is heavily gated, or is missing its first seconds.');
}
for (const c of [ours, ref]) {
  if (!c.drift || Math.abs(c.drift.secs) < 0.05) continue;
  const pct = (c.drift.secs / c.drift.over) * 100;
  say(`\n  !! ${c.path.split('/').pop()} does not run at the right speed.`);
  say(`     Start and end disagree by ${(c.drift.secs * 1000).toFixed(0)} ms over ` +
    `${c.drift.over.toFixed(0)} s, about ${pct.toFixed(2)}%.`);
  say('     Almost always a warped clip — in Ableton, turn Warp off on the');
  say('     imported stimulus and bounce again. Everything below is unreliable.');
}

/* ---- 1 and 2: spectral balance, at two drive levels ---- */

function spectral(name, title) {
  const a = slice(ours, name, { trimStart: 0.2, trimEnd: 0.2 });
  const b = slice(ref, name, { trimStart: 0.2, trimEnd: 0.2 });
  if (!a || !b) { say(`\n  ${title}: section missing from a capture`); return null; }
  const ba = bands(ours.x, a.from, a.len, ours.rate);
  const bb = bands(ref.x, b.from, b.len, ref.rate);
  const diff = ba.map((v, i) => v - bb[i]);
  // A level difference is not a tone difference. Remove the mean and report
  // it separately, otherwise every band reads as wrong by the same amount.
  const mean = diff.reduce((s, v) => s + v, 0) / diff.length;
  const rel = diff.map((v) => v - mean);
  const err = Math.sqrt(rel.reduce((s, v) => s + v * v, 0) / rel.length);

  say(`\n${title}`);
  say(`   level offset ${sign(mean)} dB, removed before comparing`);
  for (let i = 0; i < THIRD_OCTAVE.length; i += 6) {
    const row = [];
    for (let j = i; j < Math.min(i + 6, THIRD_OCTAVE.length); j++) {
      const f = THIRD_OCTAVE[j];
      row.push(`${pad(f >= 1000 ? `${f / 1000}k` : f, 5)} ${pad(sign(rel[j]), 6)}`);
    }
    say(`   ${row.join('  ')}`);
  }
  let wi = 0;
  rel.forEach((v, i) => { if (Math.abs(v) > Math.abs(rel[wi])) wi = i; });
  say(`   rms difference ${err.toFixed(2)} dB, worst ${sign(rel[wi])} dB at ${THIRD_OCTAVE[wi]} Hz`);
  worst.push({ what: title, err });
  metrics[name] = { bands: rel.map((v) => +v.toFixed(2)), rms: +err.toFixed(3), levelOffset: +mean.toFixed(2) };
  return { rel, err };
}

const quiet = spectral('sweep-quiet', '1. spectral balance, quiet sweep (-30 dBFS in)');
const loud = spectral('sweep-loud', '2. spectral balance, driven sweep (-12 dBFS in)');

if (quiet && loud) {
  // How much the response moves between the two drive levels IS the amp.
  // Two amps can share a frequency response and still feel nothing alike.
  const move = quiet.rel.map((v, i) => loud.rel[i] - v);
  const e = Math.sqrt(move.reduce((s, v) => s + v * v, 0) / move.length);
  metrics.driveMove = +e.toFixed(3);
  say(`\n3. how the response moves with drive`);
  say(`   difference between the two curves: ${e.toFixed(2)} dB rms`);
  say(`   ${e < 1 ? 'both amps tighten up by about the same amount' : 'the amps respond to level differently — this is a preamp/sag difference, not an EQ one'}`);
}

/* ---- 4: harmonic series ---- */

say(`\n4. harmonic series   (dB relative to the fundamental; ours / reference / diff)`);
let hErr = [], hN = 0;
for (const hz of manifest.toneHz) {
  say(`   ${hz} Hz`);
  for (const dbfs of manifest.toneDbfs) {
    const name = `tone-${hz}-${Math.abs(dbfs)}`;
    const a = slice(ours, name, { trimStart: 0.2, trimEnd: 0.15 });
    const b = slice(ref, name, { trimStart: 0.2, trimEnd: 0.15 });
    if (!a || !b) continue;
    const ha = harmonics(ours.x, a.from, Math.min(a.len, 16384), ours.rate, hz, 6);
    const hb = harmonics(ref.x, b.from, Math.min(b.len, 16384), ref.rate, hz, 6);
    const cells = [];
    for (let i = 0; i < ha.harmonics.length; i++) {
      const u = ha.harmonics[i], r = hb.harmonics[i];
      if (u == null || r == null) continue;
      // Below this both are measuring the noise floor and the difference is
      // meaningless; reporting it would send you chasing nothing.
      const real = u > -70 || r > -70;
      if (real) { hErr.push(u - r); hN++; }
      cells.push(`H${i + 2} ${pad(sign(u), 6)}/${pad(sign(r), 6)}${real ? pad(sign(u - r), 7) : '      ·'}`);
    }
    say(`     ${pad(`${dbfs} dBFS`, 9)}  ${cells.slice(0, 4).join('  ')}`);
  }
}
if (hN) {
  const e = Math.sqrt(hErr.reduce((s, v) => s + v * v, 0) / hN);
  const bias = hErr.reduce((s, v) => s + v, 0) / hN;
  metrics.harmonics = { rms: +e.toFixed(3), mean: +bias.toFixed(3), n: hN };
  say(`   rms difference ${e.toFixed(1)} dB over ${hN} harmonics, mean ${sign(bias)} dB`);
  say(`   ${bias > 2 ? 'ours distorts more than the reference at matched input'
    : bias < -2 ? 'ours distorts less than the reference at matched input'
    : 'overall distortion depth is matched'}`);
  worst.push({ what: 'harmonic series', err: e });
}

/* ---- 5: decay ---- */

const da = slice(ours, 'decay'), dbs = slice(ref, 'decay');
if (da && dbs) {
  const ea = envelope(ours.x, da.from, da.len, ours.rate, 50);
  const eb = envelope(ref.x, dbs.from, dbs.len, ref.rate, 50);
  const n = Math.min(ea.values.length, eb.values.length);
  // Normalise each to its own peak: this is about the shape of the decay,
  // not how loud it was.
  const pa = Math.max(...ea.values), pb = Math.max(...eb.values);
  say(`\n5. decay envelope   (struck chord, dB below each one's own peak)`);
  const row = [];
  for (let s = 0; s < 5; s++) {
    const i = Math.min(n - 1, Math.round((s * 1000) / 50));
    row.push(`${s}s ${pad(sign(ea.values[i] - pa), 6)}/${pad(sign(eb.values[i] - pb), 6)}`);
  }
  say(`   ${row.join('   ')}`);
  let se = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    if (ea.values[i] - pa < -55) break;
    se += ((ea.values[i] - pa) - (eb.values[i] - pb)) ** 2; cnt++;
  }
  const e = Math.sqrt(se / Math.max(1, cnt));
  metrics.decay = +e.toFixed(3);
  say(`   rms difference ${e.toFixed(2)} dB over the first ${(cnt * 50 / 1000).toFixed(1)} s`);
  say(`   ${e < 1.5 ? 'compression and sag behave the same' : 'the two sustain differently — look at sag and the gate'}`);
  worst.push({ what: 'decay envelope', err: e });
}

/* ---- 6: real playing ---- */

// The synthetic sections measure the amp. This one checks that the
// measurements were the ones that mattered: a guitar does not excite the
// spectrum the way a sweep does, and a difference that only shows up here is
// a difference in the range the instrument actually lives in.
for (const clip of manifest.di || []) {
  const name = `di-${clip.slug}`;
  const a = slice(ours, name, { trimStart: 0.1, trimEnd: 0.1 });
  const b = slice(ref, name, { trimStart: 0.1, trimEnd: 0.1 });
  if (!a || !b) continue;
  const ba = bands(ours.x, a.from, a.len, ours.rate);
  const bb = bands(ref.x, b.from, b.len, ref.rate);
  const diff = ba.map((v, i) => v - bb[i]);
  const mean = diff.reduce((x, v) => x + v, 0) / diff.length;
  const rel = diff.map((v) => v - mean);
  const err = Math.sqrt(rel.reduce((x, v) => x + v * v, 0) / rel.length);

  say(`\n6. real playing — ${clip.name}`);
  for (let i = 0; i < THIRD_OCTAVE.length; i += 6) {
    const row = [];
    for (let j = i; j < Math.min(i + 6, THIRD_OCTAVE.length); j++) {
      const f = THIRD_OCTAVE[j];
      row.push(`${pad(f >= 1000 ? `${f / 1000}k` : f, 5)} ${pad(sign(rel[j]), 6)}`);
    }
    say(`   ${row.join('  ')}`);
  }
  // Crest factor is how much of the playing survived: a squashed amp returns
  // a smaller number, and two amps that measure the same on a sweep can
  // differ here by a lot. Spreading a few hundred thousand samples into
  // Math.max blows the stack, so this is a plain loop.
  const crest = (c, sl) => {
    let peak = 0;
    for (let i = 0; i < sl.len; i++) peak = Math.max(peak, Math.abs(c.x[sl.from + i]));
    return db(peak / Math.max(rms(c.x, sl.from, sl.len), 1e-12));
  };
  const ca = crest(ours, a), cb = crest(ref, b);
  say(`   rms difference ${err.toFixed(2)} dB`);
  say(`   crest factor   ours ${ca.toFixed(1)} dB / ref ${cb.toFixed(1)} dB` +
    `   ${Math.abs(ca - cb) < 1.5 ? 'dynamics match' : 'one is squashing the playing more than the other'}`);
  worst.push({ what: `real playing (${clip.name})`, err });
  (metrics.playing = metrics.playing || {})[clip.slug] =
    { rms: +err.toFixed(3), crestOurs: +ca.toFixed(2), crestRef: +cb.toFixed(2) };
}

/* ---- verdict ---- */

say(`\nwhere the difference lives`);
worst.sort((a, b) => b.err - a.err);
for (const w of worst) say(`   ${w.err.toFixed(2)} dB  ${w.what}`);
const hint = {
  '1. spectral balance, quiet sweep (-30 dBFS in)': 'cab first, then the tone stack — see issues #23 and the stack values',
  '2. spectral balance, driven sweep (-12 dBFS in)': 'cab and presence, with the preamp contributing',
  'harmonic series': 'preamp: the triode kp/kn asymmetry and the stage count — issue #24',
  'decay envelope': 'sag, the gate threshold, and the power supply time constant',
};
say(`\n   start with: ${hint[worst[0].what] || worst[0].what}\n`);

if (JSON_OUT) {
  metrics.align = {
    ours: { offset: +ours.offset.toFixed(4), corr: +ours.score.toFixed(3), rate: ours.rate },
    reference: { offset: +ref.offset.toFixed(4), corr: +ref.score.toFixed(3), rate: ref.rate },
  };
  // A single number to search on. The weights say what "sounds like it"
  // means here: the harmonic series carries the most, because it is the one
  // thing an EQ cannot fake, and the two spectral curves carry the rest.
  // Decay and crest matter but are noisier, so they are kept small.
  const h = metrics.harmonics ? metrics.harmonics.rms : 0;
  const q = metrics['sweep-quiet'] ? metrics['sweep-quiet'].rms : 0;
  const d = metrics['sweep-loud'] ? metrics['sweep-loud'].rms : 0;
  const play = metrics.playing ? Object.values(metrics.playing)[0].rms : 0;
  metrics.score = +(0.40 * h + 0.20 * q + 0.20 * d + 0.12 * play
    + 0.05 * (metrics.driveMove || 0) + 0.03 * (metrics.decay || 0)).toFixed(4);
  metrics.unreliable = !!(ours.drift && Math.abs(ours.drift.secs) > 0.05)
    || !!(ref.drift && Math.abs(ref.drift.secs) > 0.05)
    || ours.score < 0.3 || ref.score < 0.3;
  process.stdout.write(`${JSON.stringify(metrics)}\n`);
}
