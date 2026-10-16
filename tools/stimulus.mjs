// The reference signal, and the one thing both amps have to be fed.
//
// Tone memory is about ten seconds long, which is why A/B-ing this amp
// against BIAS by ear across two sessions tells you nothing. The way out is
// to drive both with an identical file and measure the two recordings.
//
// The sections are chosen so that each one isolates a different block:
//
//   sweep, quiet    the linear response — the cab and the tone stack, with
//                   the preamp barely working
//   sweep, loud     the same response once everything is being driven, which
//                   is a different curve and that difference is the amp
//   tones           harmonic series at four pitches and four levels; this is
//                   the preamp's signature and the one thing an EQ cannot fake
//   decay           a struck chord left to ring, for sag and compression
//   musical         plucked strings, so there is something to listen to as
//                   well as measure
//
// Levels matter more than anything here. An amp is a nonlinear system, so its
// response at -30 dBFS and at -6 dBFS are two different responses, and a
// calibration done at one level is worth very little at the other.

import { writeWav, readWav, mono } from './lib/wavio.mjs';
import { resample } from './lib/dsp.mjs';
import { writeFileSync } from 'node:fs';

const RATE = 48000;
const TONE_HZ = [82.41, 220, 440, 880];          // low E, A3, A4, A5
const TONE_DB = [-30, -20, -12, -6];
const amp = (dbfs) => Math.pow(10, dbfs / 20);

/** Raised-cosine edges. A hard gate on a tone is a click, and a click is
 *  broadband — it would land in every harmonic bin being measured. */
function fade(out, start, len, ms = 20) {
  const n = Math.min(Math.round((RATE * ms) / 1000), len >> 1);
  for (let i = 0; i < n; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
    out[start + i] *= g;
    out[start + len - 1 - i] *= g;
  }
}

/** Logarithmic sweep: equal time per octave, so every band gets the same
 *  excitation and the band energies are directly comparable. */
function sweep(out, start, secs, f0, f1, dbfs) {
  const n = Math.round(secs * RATE);
  const k = Math.log(f1 / f0);
  const a = amp(dbfs);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const phase = ((2 * Math.PI * f0 * secs) / k) * (Math.exp((t / secs) * k) - 1);
    out[start + i] = Math.sin(phase) * a;
  }
  fade(out, start, n, 30);
  return n;
}

function tone(out, start, secs, hz, dbfs) {
  const n = Math.round(secs * RATE);
  const a = amp(dbfs);
  for (let i = 0; i < n; i++) out[start + i] = Math.sin((2 * Math.PI * hz * i) / RATE) * a;
  fade(out, start, n, 20);
  return n;
}

/** Karplus-Strong, the same generator the page uses for its built-in guitar,
 *  so the musical section is a realistic input rather than a synthesiser. */
function pluck(out, at, hz, vel, damp = 0.996, secs = 2.4) {
  const n = Math.max(2, Math.round(RATE / hz));
  const buf = new Float32Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) {
    last = last * 0.4 + (Math.random() * 2 - 1) * 0.6;
    buf[i] = last * (1 - i / n) * vel;
  }
  const start = Math.round(at * RATE);
  const dur = Math.min(out.length - start, Math.round(RATE * secs));
  let idx = 0, prev = 0;
  for (let i = 0; i < dur; i++) {
    const cur = buf[idx];
    const y = (cur + prev) * 0.5 * damp;
    buf[idx] = y; prev = cur;
    idx = (idx + 1) % n;
    out[start + i] += y;
  }
}

/**
 * Draw a section into its own buffer, normalise it to a known peak, then
 * place it. Plucks sum unpredictably — four strings struck 15 ms apart can
 * land anywhere between 1.2x and 3x a single one — and a stimulus that
 * clips is measuring the file rather than the amp.
 */
function render(out, at, secs, peakDbfs, draw) {
  const n = Math.round(secs * RATE);
  const b = new Float32Array(n);
  draw(b);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(b[i]));
  const g = peak > 1e-9 ? Math.pow(10, peakDbfs / 20) / peak : 0;
  const start = Math.round(at * RATE);
  for (let i = 0; i < n; i++) out[start + i] += b[i] * g;
}

function build() {
  const out = new Float32Array(Math.round((70 + dis.length * 31) * RATE));
  const marks = [];
  const at = (t) => Math.round(t * RATE);
  let t = 0;
  const gap = (s) => { t += s; };
  const mark = (name, secs, extra = {}) => {
    marks.push({ name, start: +t.toFixed(4), seconds: +secs.toFixed(4), ...extra });
    t += secs;
  };

  gap(1.0);                                     // noise floor, and room to align into

  // Three bursts: an envelope pattern that survives any amount of distortion,
  // cab filtering and gating, which a single click does not.
  const mStart = t;
  for (let i = 0; i < 3; i++) tone(out, at(t + i * 0.2), 0.05, 1000, -10);
  mark('marker', 0.6);
  gap(0.6);

  sweep(out, at(t), 8, 20, 20000, -30);
  mark('sweep-quiet', 8, { dbfs: -30, f0: 20, f1: 20000 });
  gap(0.8);

  sweep(out, at(t), 8, 20, 20000, -12);
  mark('sweep-loud', 8, { dbfs: -12, f0: 20, f1: 20000 });
  gap(0.8);

  // Tones: each pitch swept through four levels, so the harmonic series can
  // be read as a function of how hard the amp is being hit.
  for (const hz of TONE_HZ) {
    for (const dbfs of TONE_DB) {
      tone(out, at(t), 0.8, hz, dbfs);
      mark(`tone-${hz}-${Math.abs(dbfs)}`, 0.8, { hz, dbfs });
      gap(0.25);
    }
  }
  gap(0.6);

  // Struck hard and left alone. Sag shows up as the first half second behaving
  // differently from the rest of the decay.
  const chord = [[0, 0], [0.015, 7], [0.03, 12], [0.045, 19]];
  render(out, t, 6, -6, (b) => {
    for (const [d, semi] of chord) pluck(b, d, 82.41 * Math.pow(2, semi / 12), 1.0, 0.9985, 5.5);
  });
  mark('decay', 6, { note: 'struck E5 chord, left to ring', peakDbfs: -6 });
  gap(0.8);

  // The synthetic riff stays whatever happens, so there is always one musical
  // section that is byte-identical between runs and between machines.
  const riff = [[0, 0, 0.9], [0.45, 3, 0.7], [0.9, 5, 0.8], [1.35, 7, 0.9], [1.8, 5, 0.6],
    [2.25, 3, 0.8], [2.7, 0, 1.0], [3.4, -2, 0.85], [3.85, 0, 0.7], [4.3, 12, 0.8]];
  render(out, t, 7, -6, (b) => {
    for (const [d, semi, v] of riff) pluck(b, d, 82.41 * Math.pow(2, semi / 12), v);
  });
  mark('musical-synth', 7, { note: 'Karplus-Strong riff', peakDbfs: -6 });
  gap(1.0);

  // Real playing. The synthetic sections measure the amp; this one is what
  // tells you whether the measurements were the ones that mattered. It is
  // also the only section that will sound like anything when you A/B the two
  // captures by ear, which is still the final judge.
  for (const clip of dis) {
    const n = clip.samples.length;
    const start = Math.round(t * RATE);
    if (start + n > out.length) {
      console.error(`  ! ${clip.name} does not fit, skipped`);
      continue;
    }
    for (let i = 0; i < n; i++) out[start + i] = clip.samples[i];
    mark(`di-${clip.slug}`, n / RATE, {
      note: `real DI: ${clip.name}`, peakDbfs: -6,
      sourceRate: clip.sourceRate, resampled: clip.sourceRate !== RATE,
    });
    gap(0.8);
  }

  const total = at(t);
  const trimmed = out.subarray(0, total);

  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(trimmed[i]));

  return {
    samples: trimmed,
    manifest: {
      format: 'amp-calibration-stimulus',
      version: 1,
      sampleRate: RATE,
      seconds: +t.toFixed(3),
      peakDbfs: +(20 * Math.log10(peak)).toFixed(2),
      markerStart: +mStart.toFixed(4),
      toneHz: TONE_HZ,
      toneDbfs: TONE_DB,
      di: dis.map((d) => ({ name: d.name, slug: d.slug, sourceRate: d.sourceRate })),
      sections: marks,
    },
  };
}

/* ---------------- arguments ---------------- */

const argv = process.argv.slice(2);
const diPaths = [];
let outDir = 'calibration';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--di') diPaths.push(argv[++i]);
  else if (argv[i] === '--out') outDir = argv[++i];
  else if (!argv[i].startsWith('--')) outDir = argv[i];
}

/**
 * Load a real guitar DI: mono, at the stimulus rate, normalised to a known
 * peak. Normalising matters more than it looks — the whole file is built to
 * known levels so that "ours" and "the reference" are driven identically, and
 * a clip that arrives 9 dB hotter than the rest would be hitting a different
 * part of the amp's curve than every other section.
 */
function loadDI(path) {
  const wav = readWav(path);
  let x = mono(wav);
  if (wav.rate !== RATE) x = resample(x, wav.rate, RATE);

  // Trim leading and trailing near-silence, so a clip that was topped and
  // tailed casually does not spend four seconds of the stimulus on room tone.
  const thresh = Math.pow(10, -60 / 20);
  let a = 0, b = x.length - 1;
  while (a < b && Math.abs(x[a]) < thresh) a++;
  while (b > a && Math.abs(x[b]) < thresh) b--;
  a = Math.max(0, a - Math.round(RATE * 0.05));
  b = Math.min(x.length - 1, b + Math.round(RATE * 0.25));
  x = x.subarray(a, b + 1);

  const MAX = 30 * RATE;
  if (x.length > MAX) x = x.subarray(0, MAX);

  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  const g = peak > 1e-9 ? Math.pow(10, -6 / 20) / peak : 0;
  const samples = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) samples[i] = x[i] * g;
  // Short fades: a DI that starts mid-waveform is a click, and a click is
  // broadband enough to show up in the band analysis of the next section.
  const f = Math.round(RATE * 0.01);
  for (let i = 0; i < f; i++) {
    const w = 0.5 - 0.5 * Math.cos((Math.PI * i) / f);
    samples[i] *= w;
    samples[samples.length - 1 - i] *= w;
  }

  const name = path.split('/').pop();
  return {
    name, samples, sourceRate: wav.rate,
    slug: name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
  };
}

const dis = [];
for (const p of diPaths) {
  try {
    const clip = loadDI(p);
    dis.push(clip);
    console.log(`  DI  ${clip.name}  ${(clip.samples.length / RATE).toFixed(1)} s` +
      `${clip.sourceRate !== RATE ? `  (resampled from ${clip.sourceRate / 1000} kHz)` : ''}`);
  } catch (e) {
    console.error(`  ! could not read ${p}: ${e.message}`);
    process.exit(1);
  }
}

const { samples, manifest } = build();
const wavPath = `${outDir}/stimulus.wav`;
const bytes = writeWav(wavPath, samples, RATE);
writeFileSync(`${outDir}/stimulus.json`, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`${wavPath}  ${manifest.seconds.toFixed(1)} s, ${RATE / 1000} kHz, 24-bit, ${(bytes / 1e6).toFixed(1)} MB`);
console.log(`peak ${manifest.peakDbfs} dBFS`);
for (const s of manifest.sections) {
  console.log(`  ${String(s.start.toFixed(2)).padStart(6)}s  ${s.name}`);
}
