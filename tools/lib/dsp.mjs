// The measurement maths. No dependencies, because a calibration tool that
// needs an install is a calibration tool nobody runs.

/** In-place iterative radix-2 FFT. `re`/`im` must be a power of two long. */
export function fft(re, im) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error(`fft: ${n} is not a power of two`);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

export const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };
export const db = (x) => 20 * Math.log10(Math.max(x, 1e-12));

export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** Magnitude spectrum of a slice, Hann windowed and zero padded. */
export function spectrum(x, from, len, pad = 1) {
  const n = nextPow2(len * pad);
  const re = new Float64Array(n), im = new Float64Array(n);
  const w = hann(len);
  for (let i = 0; i < len; i++) re[i] = (x[from + i] || 0) * w[i];
  fft(re, im);
  const half = n >> 1;
  const mag = new Float64Array(half);
  // Compensate the window's coherent gain so levels are comparable to the
  // peak amplitude of the tone that produced them.
  const scale = 2 / (len * 0.5);
  for (let i = 0; i < half; i++) mag[i] = Math.hypot(re[i], im[i]) * scale;
  return { mag, binHz: 0, n };
}

export function rms(x, from = 0, len = x.length - from) {
  let s = 0;
  for (let i = 0; i < len; i++) { const v = x[from + i]; s += v * v; }
  return Math.sqrt(s / Math.max(1, len));
}

/**
 * Block RMS envelope, in dB, one value per `hop` samples. The shape a
 * compressor or a sagging power supply leaves is here and nowhere else.
 */
export function envelope(x, from, len, rate, hopMs = 10) {
  const hop = Math.max(1, Math.round((rate * hopMs) / 1000));
  const out = [];
  for (let i = from; i + hop <= from + len; i += hop) out.push(db(rms(x, i, hop)));
  return { values: out, hopMs };
}

/**
 * Where does `b` sit relative to `a`, in samples? Correlates the broadband
 * energy envelopes rather than the waveforms, which is the whole trick: a
 * distorted, EQ'd, re-amped copy of a signal looks nothing like it sample by
 * sample, but its loud and quiet moments land in the same places.
 *
 * @returns {{shift:number, score:number}} shift in samples, score in 0..1
 */
export function alignByEnvelope(a, b, rate, maxShiftSec = 10) {
  const hop = Math.round(rate / 200);            // 5 ms resolution
  const ea = coarse(a, hop), eb = coarse(b, hop);
  const maxLag = Math.round((maxShiftSec * rate) / hop);
  let best = 0, bestScore = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const s = corr(ea, eb, lag);
    if (s > bestScore) { bestScore = s; best = lag; }
  }
  return { shift: best * hop, score: bestScore };
}

function coarse(x, hop) {
  const n = Math.floor(x.length / hop);
  const e = new Float64Array(n);
  // In dB, not linear. A distorting amp compresses its own dynamics hard —
  // a 40 dB swing at the input can come out as 10 dB — so a linear envelope
  // of a cranked capture is nearly flat and correlates against nothing. In
  // dB the quiet parts keep their shape, which is what the alignment is
  // actually matching on. Floored, so digital silence does not become -inf
  // and swamp the correlation.
  let peak = 0;
  for (let i = 0; i < n; i++) {
    e[i] = rms(x, i * hop, hop);
    if (e[i] > peak) peak = e[i];
  }
  const floor = Math.max(peak, 1e-9) * 1e-4;        // 80 dB below the loudest
  for (let i = 0; i < n; i++) e[i] = Math.log10(Math.max(e[i], floor));

  // Normalising removes the level difference, which is exactly what must not
  // influence where the two line up.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += e[i] / n;
  let sd = 0;
  for (let i = 0; i < n; i++) sd += (e[i] - mean) ** 2;
  sd = Math.sqrt(sd / Math.max(1, n)) || 1;
  for (let i = 0; i < n; i++) e[i] = (e[i] - mean) / sd;
  return e;
}

function corr(a, b, lag) {
  let s = 0, n = 0;
  const from = Math.max(0, -lag);
  const to = Math.min(a.length, b.length - lag);
  for (let i = from; i < to; i++) { s += a[i] * b[i + lag]; n++; }
  return n < 50 ? -Infinity : s / n;
}

/** ISO 1/3-octave centres over the range a guitar speaker lives in. */
export const THIRD_OCTAVE = [
  50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000,
  1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000,
];

/**
 * Energy in each 1/3-octave band over a slice. Band energy of a log sweep is
 * a good stand-in for the average transfer magnitude in that band, and it is
 * far more robust than deconvolution when the thing being measured is
 * nonlinear and the capture has a little noise in it.
 */
export function bands(x, from, len, rate) {
  const n = nextPow2(len);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < len; i++) re[i] = x[from + i] || 0;
  fft(re, im);
  const half = n >> 1;
  const binHz = rate / n;
  const out = [];
  for (const f of THIRD_OCTAVE) {
    const lo = Math.max(1, Math.floor((f / Math.pow(2, 1 / 6)) / binHz));
    const hi = Math.min(half - 1, Math.ceil((f * Math.pow(2, 1 / 6)) / binHz));
    let e = 0;
    for (let i = lo; i <= hi; i++) e += re[i] * re[i] + im[i] * im[i];
    // Per-bin mean, so bands of different widths are directly comparable.
    out.push(db(Math.sqrt(e / Math.max(1, hi - lo + 1))));
  }
  return out;
}

/**
 * Level of the first `count` harmonics of `f0`, in dB relative to the
 * fundamental. The peak is taken over a small neighbourhood because nothing
 * lands exactly on a bin and a sagging amp pulls pitch slightly.
 */
export function harmonics(x, from, len, rate, f0, count = 8) {
  const { mag, n } = spectrum(x, from, len, 2);
  const binHz = rate / n;
  const pick = (f) => {
    const c = f / binHz;
    const lo = Math.max(0, Math.floor(c - 3)), hi = Math.min(mag.length - 1, Math.ceil(c + 3));
    let m = 0;
    for (let i = lo; i <= hi; i++) m = Math.max(m, mag[i]);
    return m;
  };
  const fund = pick(f0);
  const out = [];
  for (let h = 2; h <= count; h++) {
    const f = f0 * h;
    out.push(f >= rate / 2 ? null : db(pick(f) / Math.max(fund, 1e-12)));
  }
  return { fundamentalDb: db(fund), harmonics: out };
}

/**
 * Sample rate conversion with a windowed-sinc kernel.
 *
 * A guitar DI dropped into the stimulus has to come out at the stimulus rate,
 * and this file is the one place in the project where a lazy resampler would
 * be embarrassing — the README spends a page on exactly this mistake. Cutoff
 * goes below the *lower* of the two Nyquists, so downsampling is band-limited
 * before it decimates rather than after.
 */
export function resample(x, fromRate, toRate, taps = 32) {
  if (fromRate === toRate) return Float32Array.from(x);
  const ratio = toRate / fromRate;
  const cutoff = 0.46 * Math.min(1, ratio);     // cycles per input sample
  const half = taps >> 1;
  const n = Math.floor(x.length * ratio);
  const out = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const src = i / ratio;
    const c = Math.floor(src);
    let acc = 0, norm = 0;
    for (let k = -half; k <= half; k++) {
      const j = c + k;
      if (j < 0 || j >= x.length) continue;
      const d = src - j;
      const s = Math.abs(d) < 1e-9 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * d) / (Math.PI * d);
      // Blackman, same window the amp's resampler uses.
      const t = (d + half) / taps;
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * t) + 0.08 * Math.cos(4 * Math.PI * t);
      acc += x[j] * s * w;
      norm += s * w;
    }
    out[i] = norm > 1e-9 ? acc / norm : 0;
  }
  return out;
}
