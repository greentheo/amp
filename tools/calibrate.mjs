// Rank a set of candidate renders against one reference and say which
// settings came closest.
//
//   node tools/calibrate.mjs calibration/bias-jcm800.wav 'calibration/sweep-*.wav'
//
// The loop this sits in:
//
//   1. tools/bias.sh --amp "British Lead 800" --set gain=0.6 ... --out ref.wav
//   2. in the page:  await window.amp.sweep([...settings...], 'sweep')
//   3. this, to rank them
//
// Why a sweep rather than a gradient descent: the knobs interact, the error
// surface has no reason to be convex, and every evaluation costs a render.
// A coarse grid tells you where the minimum lives and — more usefully —
// whether it is a sharp minimum or a wide flat valley, which a descent would
// never show you. Refine by hand around the winner.
//
// A candidate is ranked on one weighted number, but that number is only for
// sorting. What settings won matters less than which measurement is still
// wrong at the winner, and the full report for the best candidate is printed
// for that reason.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, globSync } from 'node:fs';

const argv = process.argv.slice(2);
// Which number to sort on. The default weighs everything; --rank harmonics
// fits the preamp alone, which is the right objective when the cab is a
// separate and much larger error that would otherwise drown it out.
let rank = 'score';
const ri = argv.indexOf('--rank');
if (ri >= 0) { rank = argv[ri + 1]; argv.splice(ri, 2); }
const RANKERS = {
  score: (m) => m.score,
  harmonics: (m) => (m.harmonics ? m.harmonics.rms : Infinity),
  // |mean| alone says whether we distort more or less overall, ignoring
  // whether the shape of the series is right.
  depth: (m) => (m.harmonics ? Math.abs(m.harmonics.mean) : Infinity),
  quiet: (m) => m['sweep-quiet'].rms,
  loud: (m) => m['sweep-loud'].rms,
};
if (!RANKERS[rank]) {
  console.error(`--rank must be one of: ${Object.keys(RANKERS).join(', ')}`);
  process.exit(2);
}
const keyOf = RANKERS[rank];

const [reference, pattern] = argv;
if (!reference || !pattern) {
  console.error("usage: node tools/calibrate.mjs <reference.wav> '<candidates-glob>'");
  console.error("   e.g. node tools/calibrate.mjs calibration/bias-jcm800.wav 'calibration/sweep-*.wav'");
  process.exit(2);
}
if (!existsSync(reference)) {
  console.error(`no such reference: ${reference}`);
  process.exit(2);
}

const files = globSync(pattern).sort();
if (!files.length) {
  console.error(`nothing matched ${pattern}`);
  process.exit(2);
}

// window.amp.sweep writes this alongside the renders, so a filename can be
// turned back into the settings that produced it.
let index = {};
const manifestPath = 'calibration/sweep.json';
if (existsSync(manifestPath)) {
  try {
    for (const row of JSON.parse(readFileSync(manifestPath, 'utf8'))) {
      index[row.path.replace(/^.*\//, '')] = row.setting;
    }
  } catch { /* no manifest, fall back to filenames */ }
}

const score = (file) => {
  const out = execFileSync('node', ['tools/compare.mjs', file, reference, '--json'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out.trim().split('\n').pop());
};

console.log(`\nreference   ${reference}`);
console.log(`candidates  ${files.length}`);
console.log(`ranking by  ${rank}\n`);

const rows = [];
for (const f of files) {
  process.stdout.write(`  ${f.replace(/^.*\//, '').padEnd(28)}`);
  try {
    const m = score(f);
    rows.push({ file: f, m });
    process.stdout.write(`score ${m.score.toFixed(2)}` +
      `   harm ${m.harmonics ? m.harmonics.rms.toFixed(1) : '  - '}` +
      `  quiet ${m['sweep-quiet'].rms.toFixed(1)}` +
      `  loud ${m['sweep-loud'].rms.toFixed(1)}` +
      `${m.unreliable ? '   << unreliable' : ''}\n`);
  } catch (e) {
    process.stdout.write(`failed: ${String(e.message).split('\n')[0]}\n`);
  }
}

const ok = rows.filter((r) => !r.m.unreliable);
if (!ok.length) {
  console.log('\nnothing usable — every candidate failed alignment or drift checks.');
  process.exit(1);
}
ok.sort((a, b) => keyOf(a.m) - keyOf(b.m));

console.log(`\nbest ${Math.min(5, ok.length)} by ${rank}`);
for (const r of ok.slice(0, 5)) {
  const s = index[r.file.replace(/^.*\//, '')];
  console.log(`  ${keyOf(r.m).toFixed(3)}  ${r.file.replace(/^.*\//, '')}` +
    (s ? `\n          ${Object.entries(s)
      .filter(([k]) => !['axis', 'distance', 'cabMix', 'speaker', 'master'].includes(k))
      .map(([k, v]) => `${k}=${typeof v === 'object' && v ? JSON.stringify(v) : v}`)
      .join(' ')}` : ''));
}

// How sharp is the minimum? A wide flat valley means the knob barely
// matters and the difference is somewhere this sweep did not look.
const best = keyOf(ok[0].m), worstOk = keyOf(ok[ok.length - 1].m);
console.log(`\nspread across the sweep: ${best.toFixed(2)} to ${worstOk.toFixed(2)}`);
if (worstOk - best < 0.5) {
  console.log('  Nearly flat — these knobs are not what is different. Look elsewhere.');
}

console.log(`\n${'='.repeat(64)}\nfull report for the best candidate\n${'='.repeat(64)}`);
console.log(execFileSync('node', ['tools/compare.mjs', ok[0].file, reference],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
