// The tuner's pitch detector: YIN, on the dry input.
//
// A tuner has to be right to a fraction of a cent and never jump an octave,
// and the guitar it listens to is about the easiest signal there is — one
// note, clean, straight off the pickups. YIN (de Cheveigné and Kawahara,
// 2002) suits that: it looks for the lag at which the signal best repeats
// itself, normalised so that the first good dip wins over its multiples.
// A parabola through the peak of the energy-normalised correlation there
// gives the period to a small part of a sample, and ignores the note fading.
//
// native/ampcore/src/tuner.cpp is the same code for the app, doing the
// arithmetic in the same order, so both builds read the same note off the
// same samples (tools/tuner-parity.mjs).
//
// Below the detector: turning a frequency into a note and cents, and the
// steadying a display needs, which only the page does.

export const MIN_HZ = 30;
export const MAX_HZ = 1500;

// A dip in the normalised difference below this is a note: the first one
// wins, which is what keeps YIN off the octave below.
const THRESHOLD = 0.1;
// With no dip that deep, the deepest one still counts if it is under this.
const WORST = 0.35;
// Quieter than this (about -54 dBFS) is a string ringing out, or nothing.
const FLOOR = 0.002;

// The low-pass in front: two one-poles at this corner. Hiss is spread over
// the whole band and a guitar's pitch is not, so this takes out most of the
// noise; it also quietens the upper partials, which a stiff string pulls
// sharp of the fundamental and which would otherwise pull the reading too.
const CORNER = 1000;
// Time the low-pass gets to settle before the part that is analysed: 19 of
// its time constants, so what it started from is gone.
const SETTLE = 0.003;

export class PitchDetector {
  constructor(rate) {
    this.rate = rate;
    this.minTau = Math.max(2, Math.floor(rate / MAX_HZ));
    this.maxTau = Math.ceil(rate / MIN_HZ);
    this.pad = Math.ceil(rate * SETTLE);
    const w = 2 * Math.PI * CORNER / rate;
    this.a = w / (1 + w);
    this.d = new Float64Array(this.maxTau + 2);
    this.cm = new Float64Array(this.maxTau + 2).fill(1);
    this.s = new Float64Array(this.window());
    this.e = new Float64Array(this.window() + 1);
  }

  /** How many of the latest samples analyse() wants. */
  window() { return this.pad + 2 * this.maxTau + 2; }

  /** The pitch of the last window() samples of `x`: { hz, clarity, rms },
   *  hz 0 when there is no note. */
  analyse(x) {
    const p = { hz: 0, clarity: 0, rms: 0 };
    const need = this.window();
    if (x.length < need) return p;
    const at = x.length - need;
    const { d, cm, s, e, minTau, maxTau, a, pad } = this;

    let sum = 0;
    for (let i = pad; i < need; i++) sum += x[at + i] * x[at + i];
    p.rms = Math.sqrt(sum / (need - pad));
    if (p.rms < FLOOR) return p;

    // Filtered, and the running energy of the filtered signal, so the
    // energy of any stretch of it is one subtraction.
    let y1 = 0, y2 = 0;
    e[0] = 0;
    for (let i = 0; i < need; i++) {
      y1 += a * (x[at + i] - y1);
      y2 += a * (y1 - y2);
      s[i] = y2;
    }
    const n = need - pad;
    for (let i = 0; i < n; i++) e[i + 1] = e[i] + s[pad + i] * s[pad + i];

    // The difference function d(tau), and d normalised by its running mean,
    // which starts at 1 rather than 0 so that tau = 0 never looks like a
    // match. Stop once past the bottom of the first dip under THRESHOLD.
    const w = maxTau;
    let running = 0;
    let best = -1;
    for (let tau = 1; tau <= maxTau + 1; tau++) {
      let acc = 0;
      for (let j = 0; j < w; j++) {
        const v = s[pad + j] - s[pad + j + tau];
        acc += v * v;
      }
      d[tau] = acc;
      running += acc;
      cm[tau] = running > 0 ? acc * tau / running : 1;
      if (tau < minTau || tau > maxTau) continue;
      if (best < 0) {
        if (cm[tau] < THRESHOLD) best = tau;
      } else if (cm[tau] < cm[best]) {
        best = tau;
      } else {
        break;
      }
    }

    // No dip deep enough: take the first one nearly as deep as the deepest,
    // if the deepest is any good at all.
    if (best < 0) {
      let g = 1e9;
      for (let tau = minTau; tau <= maxTau; tau++) g = Math.min(g, cm[tau]);
      if (g > WORST) return p;
      for (let tau = minTau; tau <= maxTau; tau++) {
        if (cm[tau] > g + 0.05) continue;
        best = tau;
        while (best < maxTau && cm[best + 1] < cm[best]) best++;
        break;
      }
    }

    // The fine reading: a parabola through the peak of the correlation
    // normalised by the energy at each end, r / sqrt(E0 E1), and its two
    // neighbours. Unlike d, that is untouched by a note dying away, where d
    // leans toward longer lags as the far end of the window gets quieter.
    const e0 = e[w];
    const rho = (tau) => {
      const e1 = e[tau + w] - e[tau];
      return e0 > 0 && e1 > 0 ? (e0 + e1 - d[tau]) / (2 * Math.sqrt(e0 * e1)) : 0;
    };
    const ra = rho(best - 1), rb = rho(best), rc = rho(best + 1);
    const den = ra - 2 * rb + rc;
    let shift = den < 0 ? 0.5 * (ra - rc) / den : 0;
    if (shift > 1) shift = 1;
    if (shift < -1) shift = -1;
    p.hz = this.rate / (best + shift);
    p.clarity = Math.max(0, 1 - cm[best]);
    return p;
  }
}

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

/** The nearest note to `hz` with A4 at `a4`: { name, octave, midi, cents }. */
export function noteOf(hz, a4 = 440) {
  const m = 69 + 12 * Math.log2(hz / a4);
  const midi = Math.round(m);
  return {
    name: NAMES[((midi % 12) + 12) % 12],
    octave: Math.floor(midi / 12) - 1,
    midi,
    cents: (m - midi) * 100,
  };
}

/** The frequency of MIDI note `midi` with A4 at `a4`. */
export const hzOf = (midi, a4 = 440) => a4 * 2 ** ((midi - 69) / 12);

/**
 * Steadies the detector's readings for a display: a note has to hold for a
 * couple of looks before the name changes, the needle eases rather than
 * jitters, and a note that stops is held a moment before the tuner goes
 * blank — a pick's attack and a string's last breath both read wild.
 */
export class TunerTrack {
  constructor() { this.reset(); }

  reset() {
    this.midi = null;
    this.cents = 0;
    this.hz = 0;
    this.pending = null;
    this.seen = 0;
    this.lost = 0;
  }

  /** Feed one reading; returns what to show: { midi, cents, hz } or null. */
  push(p, a4 = 440, minClarity = 0.85) {
    if (!p.hz || p.clarity < minClarity) {
      if (++this.lost > 12) this.reset();  // ~0.4 s at 30 looks a second
      return this.midi == null ? null : this.view();
    }
    this.lost = 0;
    const n = noteOf(p.hz, a4);
    if (n.midi !== this.midi) {
      // A new note has to be seen twice running before it shows.
      if (this.pending === n.midi) this.seen++;
      else { this.pending = n.midi; this.seen = 1; }
      if (this.seen < 2 && this.midi != null) return this.view();
      this.midi = n.midi;
      this.cents = n.cents;
      this.hz = p.hz;
      return this.view();
    }
    this.pending = null;
    this.cents += (n.cents - this.cents) * 0.35;
    this.hz += (p.hz - this.hz) * 0.35;
    return this.view();
  }

  view() { return { midi: this.midi, cents: this.cents, hz: this.hz }; }
}
