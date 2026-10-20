// Is the native port the same amp as the browser one?
//
//   node tools/native-null.mjs tone
//   node tools/native-null.mjs wav <browser.wav> <native.wav>
//
// The acceptance test for porting the DSP to C++ (#38): not "sounds close"
// but "the difference is down at the noise floor of the arithmetic". The
// tone stack is checked coefficient by coefficient; renders are compared
// sample by sample, reporting the worst difference and how far below the
// signal the residual sits.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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

if (mode === 'wav') {
  const [a, b] = process.argv.slice(3).map((p) => mono(readWav(p)));
  const n = Math.min(a.length, b.length);
  let worst = 0, at = 0, se = 0, ss = 0, exact = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > worst) { worst = d; at = i; }
    if (d === 0) exact++;
    se += d * d; ss += a[i] * a[i];
  }
  const resid = 10 * Math.log10(se / Math.max(ss, 1e-30));
  console.log(`  ${n} samples, ${(100 * exact / n).toFixed(2)}% bit-identical`);
  console.log(`  worst difference ${worst.toExponential(2)} at sample ${at}${a.length !== b.length ? `   (lengths ${a.length} / ${b.length})` : ''}`);
  console.log(`  residual ${Number.isFinite(resid) ? resid.toFixed(1) : '-inf'} dB below the signal`);
  // -100 dB is a long way below anything audible and still well above the
  // float rounding floor, so a real difference cannot hide under it.
  const ok = !Number.isFinite(resid) || resid < -100;
  console.log(ok ? '  NULL — the same amp' : '  NOT NULL — the builds differ');
  process.exit(ok ? 0 : 1);
}

console.error('usage: node tools/native-null.mjs tone | wav <browser.wav> <native.wav>');
process.exit(2);
