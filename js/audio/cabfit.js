// Fitting the cab to a measured response.
//
// The cab is the one block that does not need a stimulus render to evaluate.
// It is linear, so its impulse response IS its frequency response, and that
// impulse is 90 ms long — scoring one costs a few milliseconds instead of
// the two seconds a full render takes. Which is the difference between a
// grid of twenty guesses and a few thousand evaluations of a real search.
//
// The target comes from tools/cabcurve.mjs: 24 third-octave points,
// normalised to 0 dB at 1 kHz, measured by differencing a reference amp's
// cab-on and cab-off captures.

import { renderCab, CAB_SHAPE, SPEAKERS } from './cab.js';

/**
 * Band levels of an impulse response, in dB, at the given centres.
 *
 * A plain DFT rather than an FFT: twenty-four bands times a handful of
 * probes each is a few hundred thousand multiply-adds, which is nothing, and
 * it samples exactly the frequencies asked for instead of whatever bins a
 * transform happens to land on.
 */
export function responseOf(ir, rate, freqs, probes = 7) {
  const d = ir.getChannelData(0);
  const n = d.length;
  const out = [];
  for (const f of freqs) {
    // Average power across the third-octave band, so a narrow resonance does
    // not read as a whole band and vice versa.
    const lo = f / Math.pow(2, 1 / 6), hi = f * Math.pow(2, 1 / 6);
    let power = 0;
    for (let p = 0; p < probes; p++) {
      const fr = lo * Math.pow(hi / lo, p / (probes - 1));
      const w = (2 * Math.PI * fr) / rate;
      let re = 0, im = 0;
      for (let i = 0; i < n; i++) { re += d[i] * Math.cos(w * i); im -= d[i] * Math.sin(w * i); }
      power += re * re + im * im;
    }
    out.push(10 * Math.log10(Math.max(power / probes, 1e-20)));
  }
  return out;
}

/** Error against the target, both normalised to 0 dB at 1 kHz. */
export function scoreAgainst(resp, freqs, targetDb) {
  const k = freqs.indexOf(1000);
  const ref = k >= 0 ? resp[k] : 0;
  let s = 0;
  for (let i = 0; i < resp.length; i++) {
    const d = (resp[i] - ref) - targetDb[i];
    s += d * d;
  }
  return Math.sqrt(s / resp.length);
}

/** Everything the search is allowed to move, with sane bounds. */
export const FIT_BOUNDS = {
  res: [55, 260], resQ: [0.5, 6], resDb: [0, 16],
  pres: [900, 5200], presQ: [0.4, 5], presDb: [0, 16],
  top: [1500, 7000], topQ: [0.4, 2.0],
  // top2 can sit BELOW the first lowpass. It could not before, and that was
  // part of why nothing rolled off: two corners an octave apart give 6 dB
  // per octave for that octave, where a guitar speaker falls off a cliff.
  top2: [0.45, 2.5], top2Q: [0.3, 1.5],
  tilt: [-10, 10], tiltHz: [150, 1600],
  hp: [40, 160], hpQ: [0.4, 1.6],
};

/**
 * Coordinate descent with a shrinking step.
 *
 * Not a gradient method, because several of these parameters are filter
 * corners whose effect on a third-octave curve is not smooth, and not a grid
 * because thirteen parameters do not have a grid. Coordinate descent copes
 * with both and the whole thing still runs in seconds.
 */
export async function fitCab(ctx, target, opts = {}) {
  const { freq, db } = target;
  const base = { speaker: 'v30', axis: 0.6, distance: 0.25,
    ...CAB_SHAPE, ...SPEAKERS[opts.speaker || 'v30'], ...(opts.start || {}) };
  delete base.name;

  const keys = Object.keys(FIT_BOUNDS).filter((k) => k in base);
  const evaluate = async (p) =>
    scoreAgainst(responseOf(await renderCab(ctx, p), ctx.sampleRate, freq), freq, db);

  // Several starts, best kept.
  //
  // Coordinate descent on this surface is path dependent — widening the
  // bounds once made the answer *worse*, which is the signature of a search
  // settling into whichever local minimum it happened to walk into. A fit
  // costs under a second, so the cure is to run it from a few places and
  // keep the best rather than to believe the first one.
  const restarts = opts.restarts ?? 6;
  const seed = opts.seed ?? 12345;
  let rnd = seed >>> 0;
  const rand = () => {
    rnd = (Math.imul(rnd ^ (rnd >>> 15), 1 | rnd) + 0x6d2b79f5) >>> 0;
    return (rnd >>> 8) / 16777216;
  };

  let bestOverall = null;
  for (let r = 0; r < restarts; r++) {
    const start = r === 0 ? { ...base } : { ...base };
    if (r > 0) {
      for (const k of keys) {
        const [lo, hi] = FIT_BOUNDS[k];
        start[k] = lo + rand() * (hi - lo);
      }
    }
    const got = await descend(start, keys, evaluate, opts);
    if (!bestOverall || got.bestErr < bestOverall.bestErr) bestOverall = { ...got, restart: r };
  }

  const { best, bestErr, trace } = bestOverall;
  return finish(best, bestErr, trace, base, keys, bestOverall.restart);
}

function finish(best, bestErr, trace, base, keys, restart) {
  const changed = {};
  for (const k of keys) {
    if (Math.abs(best[k] - base[k]) > 1e-9) changed[k] = +best[k].toFixed(4);
  }
  return { err: +bestErr.toFixed(3), fitted: best, changed, trace, restart };
}

async function descend(start, keys, evaluate, opts) {
  let best = { ...start };
  let bestErr = await evaluate(best);
  const trace = [{ pass: 0, err: +bestErr.toFixed(3) }];

  // Greedy line search per coordinate: keep stepping the same way while it
  // keeps helping, rather than one step per direction per pass. A single
  // step gets stuck almost immediately when several parameters have to move
  // a long way together, which is exactly the case here — the top end was
  // 20 dB out and no one small step improves that enough to be taken.
  const passes = opts.passes || 10;
  for (let pass = 0; pass < passes; pass++) {
    const frac = 0.35 * Math.pow(0.6, pass);
    let moved = false;
    for (const k of keys) {
      const [lo, hi] = FIT_BOUNDS[k];
      const step = (hi - lo) * frac;
      for (const dir of [1, -1]) {
        for (let n = 0; n < 24; n++) {
          const v = Math.max(lo, Math.min(hi, best[k] + dir * step));
          if (v === best[k]) break;
          const cand = { ...best, [k]: v };
          const err = await evaluate(cand);
          if (err < bestErr - 1e-4) { best = cand; bestErr = err; moved = true; }
          else break;
        }
      }
    }
    trace.push({ pass: pass + 1, err: +bestErr.toFixed(3) });
    if (!moved && pass > 2) break;
  }
  return { best, bestErr, trace };
}
