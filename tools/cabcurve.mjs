// Measure a cabinet's frequency response by differencing two captures of the
// same stimulus, one with the cab and one without.
//
//   node tools/cabcurve.mjs <with-cab.wav> <no-cab.wav> [--out target.json]
//
// This is exact, not a fit. A speaker cab is the last block in the chain and
// it is linear, so Y_with = cab * Y_without for every frequency, whatever
// the preamp did upstream. Dividing one spectrum by the other leaves the
// cab's own response and nothing else — the amp, its distortion and its
// settings all cancel.
//
// Which makes this the one part of the amp that does not need searching. The
// preamp had to be swept because its nonlinearity means there is no clean
// way to see it in isolation; the cab can simply be measured.
//
// What this is NOT: a way to lift someone's impulse response. It produces a
// 24-point 1/3-octave curve — a target to fit our own filter model against,
// which is ordinary calibration. Deriving and shipping a competitor's IR
// would be a different thing entirely and is not what this does.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { readWav, mono } from './lib/wavio.mjs';
import { alignByEnvelope, bands, THIRD_OCTAVE } from './lib/dsp.mjs';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const oi = process.argv.indexOf('--out');
const outPath = oi >= 0 ? process.argv[oi + 1] : null;

if (args.length < 2) {
  console.error('usage: node tools/cabcurve.mjs <with-cab.wav> <no-cab.wav> [--out target.json]');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync('calibration/stimulus.json', 'utf8'));
const stimWav = readWav('calibration/stimulus.wav');
const stim = mono(stimWav);
const marker = manifest.sections.find((s) => s.name === 'marker');

function load(path) {
  if (!existsSync(path)) { console.error(`no such file: ${path}`); process.exit(2); }
  const wav = readWav(path);
  const x = mono(wav);
  const { shift, score } = alignByEnvelope(stim, stimWav.rate, x, wav.rate, 10,
    marker ? { start: marker.start, seconds: marker.seconds } : null);
  return { path, x, rate: wav.rate, offset: shift, score };
}

/** Band levels over a named section. */
function level(cap, name) {
  const s = manifest.sections.find((sec) => sec.name === name);
  if (!s) return null;
  const from = Math.round((cap.offset + s.start + 0.2) * cap.rate);
  const len = Math.round((s.seconds - 0.4) * cap.rate);
  if (from < 0 || from + len > cap.x.length) return null;
  return bands(cap.x, from, len, cap.rate);
}

const withCab = load(args[0]);
const noCab = load(args[1]);

// Both sweeps, averaged. They excite the same bands at different drive
// levels, and a linear block answers the same either way — so a difference
// between the two is a sign something upstream is not settling, which is
// worth seeing rather than averaging away silently.
const curves = [];
for (const section of ['sweep-quiet', 'sweep-loud']) {
  const a = level(withCab, section), b = level(noCab, section);
  if (!a || !b) continue;
  curves.push({ section, rel: a.map((v, i) => v - b[i]) });
}
if (!curves.length) { console.error('neither sweep section was found in both captures'); process.exit(1); }

const avg = THIRD_OCTAVE.map((_, i) =>
  curves.reduce((s, c) => s + c.rel[i], 0) / curves.length);
// Normalise to 0 dB at 1 kHz: what matters is the shape, and the overall
// level is the convolution's gain, which is set elsewhere.
const ref = avg[THIRD_OCTAVE.indexOf(1000)];
const shape = avg.map((v) => v - ref);

console.log(`\n  with cab   ${withCab.path}   corr ${withCab.score.toFixed(2)}`);
console.log(`  no cab     ${noCab.path}   corr ${noCab.score.toFixed(2)}`);
console.log(`\ncabinet response, 1/3 octave, 0 dB at 1 kHz\n`);

const span = 44;
for (let i = 0; i < THIRD_OCTAVE.length; i++) {
  const f = THIRD_OCTAVE[i];
  const v = shape[i];
  // -40..+10 dB across the bar, so the rolloff is visible rather than clipped
  const pos = Math.max(0, Math.min(span, Math.round(((v + 40) / 50) * span)));
  const zero = Math.round(((0 + 40) / 50) * span);
  let bar = '';
  for (let c = 0; c <= span; c++) bar += c === pos ? '#' : (c === zero ? '|' : (c < pos ? '-' : ' '));
  console.log(`  ${String(f >= 1000 ? `${f / 1000}k` : f).padStart(5)} ${v.toFixed(1).padStart(7)}  ${bar}`);
}

if (curves.length === 2) {
  const d = Math.sqrt(curves[0].rel.reduce((s, v, i) =>
    s + ((v - curves[0].rel[THIRD_OCTAVE.indexOf(1000)])
       - (curves[1].rel[i] - curves[1].rel[THIRD_OCTAVE.indexOf(1000)])) ** 2, 0) / THIRD_OCTAVE.length);
  console.log(`\n  the two drive levels agree to ${d.toFixed(2)} dB rms` +
    `${d > 1 ? '  <-- they should not disagree; something upstream is level dependent' : ''}`);
}

if (outPath) {
  writeFileSync(outPath, `${JSON.stringify({
    format: 'amp-cab-target', version: 1,
    withCab: args[0], noCab: args[1],
    freq: THIRD_OCTAVE, db: shape.map((v) => +v.toFixed(2)),
  }, null, 2)}\n`);
  console.log(`\n  written to ${outPath}`);
}
