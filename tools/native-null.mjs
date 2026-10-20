// Is the native port the same amp as the browser one?
//
//   node tools/native-null.mjs tone
//   node tools/native-null.mjs wav <browser.wav> <native.wav>
//   node tools/native-null.mjs chain
//
// The acceptance test for porting the DSP to C++ (#38): not "sounds close"
// but "the difference is down at the noise floor of the arithmetic". The
// tone stack is checked coefficient by coefficient; renders are compared
// sample by sample, reporting the worst difference and how far below the
// signal the residual sits.
//
// `chain` re-runs the full-chain check: every calibration/chain-*.json that
// window.amp.renderChain(name) saved beside its browser render is rendered
// again natively (ampcore-render --chain) and nulled against it.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coeffs, STACKS } from '../js/audio/tonestack.js';
import { readWav, mono } from './lib/wavio.mjs';

const BIN = 'native/ampcore/build/ampcore-render';
const mode = process.argv[2];

if (mode === 'tone') {
  if (!existsSync(BIN)) { console.error(`build ${BIN} first`); process.exit(2); }
  const grid = [0, 0.37, 1];
  let worst = 0, where = '', n = 0;
  for (const stack of Object.keys(STACKS)) {
    for (const t of grid) for (const m of grid) for (const l of grid) {
      const js = coeffs(stack, t, m, l, 192000);
      const cc = JSON.parse(execFileSync(BIN, ['--dump-tone', stack, String(t), String(m), String(l), '192000'], { encoding: 'utf8' }));
      for (const k of Object.keys(js)) {
        const rel = Math.abs(js[k] - cc[k]) / Math.max(Math.abs(js[k]), 1e-300);
        if (rel > worst) { worst = rel; where = `${stack} t=${t} m=${m} l=${l} ${k}`; }
        n++;
      }
    }
  }
  console.log(`tone stack: ${n} coefficients compared across ${Object.keys(STACKS).length} stacks`);
  console.log(`  worst relative difference ${worst.toExponential(2)}${worst ? `  (${where})` : ''}`);
  // A few ulp is the libm's exp() and the JS engine's disagreeing in the last
  // bit; anything structural would be orders of magnitude bigger.
  const ok = worst < 1e-13;
  console.log(ok ? '  same coefficients' : '  DIFFERENT — the port of the tone stack is wrong');
  process.exit(ok ? 0 : 1);
}

/** How far apart two renders are, sample by sample. */
function compare(a, b) {
  const n = Math.min(a.length, b.length);
  let worst = 0, at = 0, se = 0, ss = 0, exact = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > worst) { worst = d; at = i; }
    if (d === 0) exact++;
    se += d * d; ss += a[i] * a[i];
  }
  const resid = 10 * Math.log10(se / Math.max(ss, 1e-30));
  // -100 dB is a long way below anything audible and still well above the
  // float rounding floor, so a real difference cannot hide under it.
  const ok = !Number.isFinite(resid) || resid < -100;
  return { n, worst, at, exact, resid, ok, lengths: a.length !== b.length ? `${a.length} / ${b.length}` : '' };
}

const dB = (r) => (Number.isFinite(r) ? r.toFixed(1) : '-inf');

if (mode === 'wav') {
  const [a, b] = process.argv.slice(3).map((p) => mono(readWav(p)));
  const r = compare(a, b);
  console.log(`  ${r.n} samples, ${(100 * r.exact / r.n).toFixed(2)}% bit-identical`);
  console.log(`  worst difference ${r.worst.toExponential(2)} at sample ${r.at}${r.lengths ? `   (lengths ${r.lengths})` : ''}`);
  console.log(`  residual ${dB(r.resid)} dB below the signal`);
  console.log(r.ok ? '  NULL — the same amp' : '  NOT NULL — the builds differ');
  process.exit(r.ok ? 0 : 1);
}

if (mode === 'chain') {
  if (!existsSync(BIN)) { console.error(`build ${BIN} first`); process.exit(2); }
  const names = readdirSync('calibration')
    .filter((f) => /^chain-.*\.json$/.test(f) && existsSync(`calibration/${f.replace(/json$/, 'wav')}`))
    .map((f) => f.replace(/\.json$/, ''));
  if (!names.length) {
    console.error('no calibration/chain-*.json: render some with window.amp.renderChain(name) first');
    process.exit(2);
  }
  let failed = 0;
  for (const name of names) {
    const out = join(tmpdir(), `${name}-native.wav`);
    execFileSync(BIN, ['calibration/stimulus.wav', out, '--chain', `calibration/${name}.json`]);
    const r = compare(mono(readWav(`calibration/${name}.wav`)), mono(readWav(out)));
    rmSync(out);
    if (!r.ok) failed++;
    console.log(`  ${name.padEnd(24)} ${dB(r.resid).padStart(7)} dB  ${(100 * r.exact / r.n).toFixed(1).padStart(5)}% bit-identical  ${r.ok ? 'null' : 'NOT NULL'}`);
  }
  process.exit(failed ? 1 : 0);
}

console.error('usage: node tools/native-null.mjs tone | wav <browser.wav> <native.wav> | chain');
process.exit(2);
