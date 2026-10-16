// Fetch a CC0 guitar DI and assemble a reference phrase from it.
//
//   node tools/fetch-di.mjs
//
// Something has to go in `calibration/di/` before the calibration loop can
// run, and a real recording of a real guitar is worth a great deal more than
// anything synthesised — a pickup, a string and an instrument input do things
// to a signal that Karplus-Strong does not.
//
// The source is FreePats "Electric Guitar FSBS (direct)": a Fender recorded
// straight into an audio interface's instrument input, 24-bit/48 kHz mono,
// released under CC0 1.0. Public domain, so it can sit in a public repo's
// workflow without anyone having to think about it.
//
//   https://freepats.zenvoid.org/ElectricGuitar/clean-electric-guitar.html
//   https://github.com/freepats/electric-guitar-FSBS-direct
//
// BE CLEAR ABOUT WHAT THIS IS. The source is a sampled instrument: single
// notes, played one at a time, each left to ring for thirty seconds. So the
// *tone* here is genuinely real — real pickup, real strings, real DI, real
// decay — but the *performance* is assembled by this script. Chords are real
// notes layered at realistic strum offsets rather than six strings actually
// struck together, and there are no palm mutes, because a palm mute is a
// different timbre and not a shorter note, and faking one would put a lie
// into the reference.
//
// It is a good stand-in and a bad substitute. A clip of you playing is still
// the better input, and this exists so that not having recorded one yet is
// not a reason to stop.

import { readWav, writeWav, mono } from './lib/wavio.mjs';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';

const REPO = 'https://raw.githubusercontent.com/freepats/electric-guitar-FSBS-direct';
const REF = '4c1d54601836c3e1a262b0bb0f3dea0c0a881ad3';   // pinned: the upstream is public domain and stable, but a reference that can change under you is not a reference
const CACHE = 'calibration/di/.freepats';
const OUT = 'calibration/di/freepats-cc0-reference.wav';
const RATE = 48000;

// The subset the phrase needs, by the set's own file naming.
const NOTES = {
  E2: 'E2_s1_01', F2: 'F2_s1_01', C2: 'C2_s1_01',
  A2: 'A2_s2_01', C3: 'C3_s2_01',
  D3: 'D3_s3_01', E3: 'E3_s3_01',
  G3: 'G3_s4_01', B3: 'B3_s5_01', 'C#4': 'C#4_s5_01',
  E4: 'E4_s6_01', G4: 'G4_s6_01', B4: 'B4_s6_01', C5: 'C5_s6_01', D5: 'D5_s6_01',
};
// Softer takes, for the quiet phrases. Real dynamics, not a gain change —
// a guitar picked softly is a different spectrum, not a smaller one.
const SOFT = { E2: 'E2_s1_soft_01', A2: 'A2_s2_soft_01', C3: 'C3_s2_soft_01', E3: 'E3_s3_soft_01' };

async function fetchNote(file) {
  mkdirSync(CACHE, { recursive: true });
  const path = `${CACHE}/${file}.wav`;
  if (existsSync(path)) return path;
  const url = `${REPO}/${REF}/samples/bridge/${encodeURIComponent(file)}.wav`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${file}: ${res.status} from ${url}`);
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  return path;
}

const loaded = new Map();
function note(name, soft = false) {
  const key = `${name}${soft ? '/soft' : ''}`;
  if (!loaded.has(key)) throw new Error(`${key} was never fetched`);
  return loaded.get(key);
}

/**
 * Place a note. `hold` is how long before it is released; a real player's
 * left hand damps a note far more often than they let it ring out, and a
 * phrase made entirely of 30-second sustains sounds nothing like playing.
 */
function place(out, at, samples, { gain = 1, hold = null, offset = 0 } = {}) {
  const start = Math.round(at * RATE);
  const from = Math.round(offset * RATE);
  const len = hold == null
    ? samples.length - from
    : Math.min(samples.length - from, Math.round(hold * RATE));
  const rel = Math.round(RATE * 0.06);            // 60 ms release, not a cut
  for (let i = 0; i < len && start + i < out.length; i++) {
    const g = i > len - rel ? (len - i) / rel : 1;
    out[start + i] += samples[from + i] * gain * g;
  }
}

/** A strum: the same notes, but arriving one after another the way a pick
 *  crosses the strings, low to high. */
function strum(out, at, names, { gain = 1, hold = null, spread = 0.022, soft = false } = {}) {
  names.forEach((n, i) => {
    place(out, at + i * spread, note(n, soft), {
      // The pick loses a little energy as it crosses, and the wound strings
      // are louder than the plain ones anyway.
      gain: gain * (1 - i * 0.04), hold: hold == null ? null : hold - i * spread,
    });
  });
}

async function main() {
  const want = [...Object.entries(NOTES).map(([k, f]) => [k, f, false]),
    ...Object.entries(SOFT).map(([k, f]) => [`${k}/soft`, f, true])];

  process.stdout.write(`fetching ${want.length} CC0 samples`);
  for (const [key, file] of want) {
    const path = await fetchNote(file);
    const w = readWav(path);
    if (w.rate !== RATE) throw new Error(`${file} is ${w.rate} Hz, expected ${RATE}`);
    loaded.set(key, mono(w));
    process.stdout.write('.');
  }
  process.stdout.write('\n');

  const out = new Float32Array(Math.round(26 * RATE));

  // 1. single notes, low to high, each damped before the next — the plainest
  //    look at what the amp does to one string.
  let t = 0.2;
  for (const [n, hold] of [['E2', 0.75], ['G3', 0.75], ['A2', 0.75], ['C3', 0.75],
    ['E3', 0.75], ['B3', 0.75], ['E4', 1.2]]) {
    place(out, t, note(n), { gain: 0.85, hold });
    t += 0.78;
  }

  // 2. the same shape played softly. The difference between this and the
  //    phrase above is the thing a guitar amp is for.
  t += 0.4;
  for (const n of ['E2', 'A2', 'C3', 'E3']) {
    place(out, t, note(n, true), { gain: 0.9, hold: 0.7 });
    t += 0.72;
  }

  // 3. power chords — root and fifth, which is where a gain stage spends
  //    most of its life and where intermodulation shows up first.
  t += 0.5;
  for (const [a, b] of [['E2', 'B3'], ['C2', 'G3'], ['D3', 'A2'], ['E2', 'B3']]) {
    strum(out, t, [a, b], { gain: 0.95, hold: 0.85, spread: 0.014 });
    t += 0.95;
  }

  // 4. full chords, let ring. Four notes into a distorting amp is the
  //    hardest thing you can ask it to do and stay listenable.
  t += 0.4;
  strum(out, t, ['E2', 'B3', 'E4', 'G4'], { gain: 0.9, hold: 2.4 });        // Em
  t += 2.6;
  strum(out, t, ['C3', 'G3', 'C5', 'E4'], { gain: 0.9, hold: 2.4 });        // C
  t += 2.6;
  strum(out, t, ['D3', 'A2', 'D5', 'C#4'], { gain: 0.85, hold: 2.4 });      // D
  t += 2.8;

  // 5. one chord hit hard and left alone, for sustain and sag.
  strum(out, t, ['E2', 'B3', 'E4', 'B4'], { gain: 1.0, spread: 0.018 });
  t += 4.5;

  const total = Math.min(out.length, Math.round(t * RATE));
  const clip = out.subarray(0, total);

  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(clip[i]));
  // -6 dBFS, matching what stimulus.mjs would normalise it to anyway, so the
  // file on disk is the file that gets used.
  const g = Math.pow(10, -6 / 20) / peak;
  for (let i = 0; i < total; i++) clip[i] *= g;

  mkdirSync('calibration/di', { recursive: true });
  writeWav(OUT, clip, RATE);
  writeFileSync('calibration/di/SOURCE.txt',
    `${OUT}\n\nAssembled by tools/fetch-di.mjs from FreePats "Electric Guitar\n` +
    `FSBS (direct)", a Fender recorded direct into an instrument input,\n` +
    `24-bit/48 kHz, released under CC0 1.0 (public domain).\n\n` +
    `  https://freepats.zenvoid.org/ElectricGuitar/clean-electric-guitar.html\n` +
    `  https://github.com/freepats/electric-guitar-FSBS-direct\n\n` +
    `The tone is real. The performance is not: the source is single notes,\n` +
    `so chords here are real notes layered at strum offsets rather than six\n` +
    `strings actually struck, and there are no palm mutes. Replace this with\n` +
    `a clip of your own playing when you have one.\n`);

  console.log(`${OUT}  ${(total / RATE).toFixed(1)} s, 48 kHz, 24-bit, peak -6 dBFS`);
  console.log(`source: FreePats Electric Guitar FSBS (direct), CC0 1.0`);
  console.log(`cached samples in ${CACHE}/ (delete to re-fetch)`);
}

main().catch((e) => { console.error(`\n${e.message}`); process.exit(1); });
