// Checks the tone stack against things that must be true of a passive RC
// network, and checks that the discrete filter actually matches the analogue
// response it was derived from.
import { STACKS, analogCoeffs, analogResponse, coeffs, step } from '../js/audio/tonestack.js';

const RATE = 192000;              // the 4x rate the filter runs at
let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('  FAIL ' + msg); } };

// Magnitude of the running filter at one frequency, by driving it with a sine.
function measure(stack, t, m, l, hz) {
  const k = coeffs(stack, t, m, l, RATE);
  const s = [0, 0, 0];
  const n = Math.max(4096, Math.round(RATE / hz) * 64);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const y = step(k, s, Math.sin(2 * Math.PI * hz * i / RATE));
    if (i > n * 0.5) peak = Math.max(peak, Math.abs(y));   // skip the transient
  }
  return peak;
}

console.log('1. passive network can never have gain');
for (const id of Object.keys(STACKS)) {
  let worst = 0, where = '';
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    for (const m of [0, 0.25, 0.5, 0.75, 1]) {
      for (const l of [0, 0.25, 0.5, 0.75, 1]) {
        const c = analogCoeffs(STACKS[id], t, m, l);
        for (let hz = 10; hz < 20000; hz *= 1.15) {
          const g = analogResponse(c, hz);
          if (g > worst) { worst = g; where = `t=${t} m=${m} l=${l} @${hz.toFixed(0)}Hz`; }
        }
      }
    }
  }
  console.log(`   ${id.padEnd(9)} max gain ${(20 * Math.log10(worst)).toFixed(2)} dB   ${where}`);
  ok(worst <= 1.001, `${id} has gain above unity (${worst.toFixed(4)})`);
}

console.log('2. DC is blocked — a single zero at the origin');
// The numerator has no constant term, so |H| must fall off proportionally to
// frequency down there: halve the frequency and the magnitude halves too.
for (const id of Object.keys(STACKS)) {
  const c = analogCoeffs(STACKS[id], 0.5, 0.5, 0.5);
  const a = analogResponse(c, 0.01), b = analogResponse(c, 0.005);
  ok(Math.abs(a / b - 2) < 0.01, `${id} does not roll off to DC (ratio ${(a / b).toFixed(4)})`);
  ok(a < 1e-3, `${id} still passing ${a.toExponential(2)} at 0.01 Hz`);
}
console.log('   all stacks: first order roll-off to zero at DC');

console.log('3. the discrete filter matches the analogue response');
for (const id of ['bassman', 'jcm800', 'ac30']) {
  let worstErr = 0, at = 0;
  const c = analogCoeffs(STACKS[id], 0.6, 0.4, 0.7);
  for (const hz of [40, 80, 150, 300, 500, 1000, 2000, 4000, 8000]) {
    const want = analogResponse(c, hz);
    const got = measure(id, 0.6, 0.4, 0.7, hz);
    const err = Math.abs(20 * Math.log10(got / want));
    if (err > worstErr) { worstErr = err; at = hz; }
  }
  console.log(`   ${id.padEnd(9)} worst error ${worstErr.toFixed(3)} dB at ${at} Hz`);
  ok(worstErr < 0.5, `${id} discrete filter is ${worstErr.toFixed(2)} dB off the analogue response`);
}

console.log('4. the Marshall mid scoop at noon');
{
  const c = analogCoeffs(STACKS.jcm800, 0.5, 0.5, 0.5);
  let min = Infinity, minHz = 0;
  for (let hz = 100; hz < 2000; hz *= 1.02) {
    const g = analogResponse(c, hz);
    if (g < min) { min = g; minHz = hz; }
  }
  const lo = analogResponse(c, 80), hi = analogResponse(c, 6000);
  console.log(`   scoop ${(20 * Math.log10(min)).toFixed(1)} dB at ${minHz.toFixed(0)} Hz`
    + `  (80Hz ${(20 * Math.log10(lo)).toFixed(1)} dB, 6kHz ${(20 * Math.log10(hi)).toFixed(1)} dB)`);
  ok(minHz > 150 && minHz < 1200, `scoop at ${minHz.toFixed(0)}Hz is not where a Marshall scoops`);
  ok(min < lo && min < hi, 'no mid scoop at all');
}

console.log('5. each control moves its own band the right way');
for (const id of ['bassman', 'jcm800']) {
  const at = (t, m, l, hz) => analogResponse(analogCoeffs(STACKS[id], t, m, l), hz);
  ok(at(0.9, 0.5, 0.5, 5000) > at(0.1, 0.5, 0.5, 5000), `${id} treble does not lift 5k`);
  ok(at(0.5, 0.5, 0.9, 80) > at(0.5, 0.5, 0.1, 80), `${id} bass does not lift 80`);
  ok(at(0.5, 0.9, 0.5, 600) > at(0.5, 0.1, 0.5, 600), `${id} mid does not lift 600`);
  console.log(`   ${id.padEnd(9)} treble +${(20 * Math.log10(at(0.9,0.5,0.5,5000) / at(0.1,0.5,0.5,5000))).toFixed(1)} dB @5k`
    + `, bass +${(20 * Math.log10(at(0.5,0.5,0.9,80) / at(0.5,0.5,0.1,80))).toFixed(1)} dB @80`
    + `, mid +${(20 * Math.log10(at(0.5,0.9,0.5,600) / at(0.5,0.1,0.5,600))).toFixed(1)} dB @600`);
}

console.log('6. stable and finite everywhere on the control grid');
{
  let bad = 0;
  for (const id of Object.keys(STACKS)) {
    for (const t of [0, 0.5, 1]) for (const m of [0, 0.5, 1]) for (const l of [0, 0.5, 1]) {
      const k = coeffs(id, t, m, l, RATE);
      const s = [0, 0, 0];
      let peak = 0;
      for (let i = 0; i < 20000; i++) {
        const y = step(k, s, Math.random() * 2 - 1);
        if (!Number.isFinite(y)) { bad++; break; }
        if (i > 10000) peak = Math.max(peak, Math.abs(y));
      }
      if (peak > 2) bad++;
    }
  }
  ok(bad === 0, `${bad} control settings blew up or went non-finite`);
  console.log(`   ${bad} unstable settings out of ${Object.keys(STACKS).length * 27}`);
}

console.log(fails === 0 ? '\nall checks passed' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
