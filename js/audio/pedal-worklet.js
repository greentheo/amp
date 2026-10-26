// The pedals: everything a stompbox does, sample by sample.
//
// One processor class per pedal type, all registered from this file. Every
// parameter is normalised to 0..1 here and mapped to its real range inside
// the pedal, so the main thread, the UI and the MIDI layer can treat every
// knob on every pedal identically — a CC goes 0..127, a knob goes 0..1, and
// nothing between them has to know whether it is moving a delay time or a
// fuzz bias.
//
// Bypass is a short crossfade, not a rewire. Rewiring a live graph clicks,
// and a footswitch that clicks is the first thing anyone notices. Once a
// pedal has been off long enough to settle it drops to a straight copy of
// its input, which is bit-exact — so a board of bypassed pedals is not just
// quiet, it is identical to no board at all, and calibration renders through
// it are untouched. The delay is the exception, deliberately: switch it off
// and its repeats ring out instead of being cut, which is what a buffered
// delay pedal does and what players expect.
//
// The two pedals that clip — overdrive and fuzz — run at 4x, with the same
// resampler and the same 11 kHz corner as the amp. That corner is cheap
// here for the same reason it is cheap there: the cab after them is 33 dB
// down by 8 kHz. The resampler is copied rather than imported because
// module imports inside an AudioWorklet are not something to bet an iPad
// install on.

const OS = 4;
const CUT_HZ = 11000;
const TAPS = 16 * OS;

function designTaps(n, cutoff) {
  const h = new Float32Array(n);
  const c = (n - 1) / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = i - c;
    const sinc = Math.abs(x) < 1e-9 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
      + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= sum;
  return h;
}

/** The amp's polyphase up/down pair, as an object a pedal can own. */
class Resampler {
  constructor() {
    this.h = designTaps(TAPS, CUT_HZ / (sampleRate * OS));
    this.phases = [];
    const len = Math.ceil(TAPS / OS);
    for (let p = 0; p < OS; p++) {
      const b = new Float32Array(len);
      for (let k = 0; k < len; k++) {
        const idx = k * OS + p;
        b[k] = idx < TAPS ? this.h[idx] * OS : 0;
      }
      this.phases.push(b);
    }
    this.upLine = new Float32Array(len);
    this.downLine = new Float32Array(TAPS);
  }

  up(x, out) {
    const line = this.upLine;
    for (let i = line.length - 1; i > 0; i--) line[i] = line[i - 1];
    line[0] = x;
    for (let p = 0; p < OS; p++) {
      const b = this.phases[p];
      let acc = 0;
      for (let k = 0; k < b.length; k++) acc += b[k] * line[k];
      out[p] = acc;
    }
  }

  down(buf) {
    const line = this.downLine;
    for (let i = TAPS - 1; i >= OS; i--) line[i] = line[i - OS];
    for (let p = 0; p < OS; p++) line[OS - 1 - p] = buf[p];
    let acc = 0;
    for (let i = 0; i < TAPS; i++) acc += this.h[i] * line[i];
    return acc;
  }

  reset() { this.upLine.fill(0); this.downLine.fill(0); }
}

const poleAt = (hz, rate) => 1 - Math.exp((-2 * Math.PI * hz) / rate);
const dbGain = (db) => Math.pow(10, db / 20);
/** Level knobs everywhere: -12..+12 dB, unity at noon. */
const levelGain = (v) => dbGain((v - 0.5) * 24);

/**
 * A soft clipper whose knee hardness is a parameter: linear for small
 * signals, saturating at +-1. h=2 is round like a diode pair, h=5 is close
 * to a hard clip. Same family as softTube() in the amp.
 */
function clip(x, h) {
  return x / Math.pow(1 + Math.pow(Math.abs(x), h), 1 / h);
}

/** Cubic Hermite read from a circular buffer, `d` samples behind `w`. */
function readHermite(buf, w, d) {
  const len = buf.length;
  let pos = w - d;
  while (pos < 0) pos += len;
  const i1 = Math.floor(pos);
  const f = pos - i1;
  const i0 = (i1 - 1 + len) % len, i2 = (i1 + 1) % len, i3 = (i1 + 2) % len;
  const y0 = buf[i0], y1 = buf[i1 % len], y2 = buf[i2], y3 = buf[i3];
  const c1 = 0.5 * (y2 - y0);
  const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
  const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
  return ((c3 * f + c2) * f + c1) * f + y1;
}

/**
 * What every pedal shares: the on/off crossfade, the settled-bypass fast
 * path, and mono in, mono out.
 */
class Pedal extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mix = 0;                                  // 0 bypassed .. 1 engaged
    this.aMix = 1 - Math.exp(-1 / (0.006 * sampleRate));
    this.idleDone = false;
    this.alive = true;
    this.port.onmessage = (e) => { if (e.data && e.data.type === 'stop') this.alive = false; };
  }

  /** True while a bypassed pedal still has something to say (delay tails). */
  trails() { return false; }

  /** Called once when a pedal settles into bypass, to clear its memory so it
   *  does not come back on playing whatever it was holding. */
  idle() {}

  process(inputs, outputs, params) {
    const out = outputs[0];
    if (!out || !out.length) return this.alive;
    const inp = inputs[0];
    const x = inp && inp.length ? inp[0] : null;
    const y = out[0];
    const n = y.length;
    const on = params.on[0] >= 0.5 ? 1 : 0;

    if (on === 0 && this.mix < 1e-4 && !this.trails()) {
      this.mix = 0;
      if (x) y.set(x); else y.fill(0);
      if (!this.idleDone) { this.idle(); this.idleDone = true; }
    } else {
      this.idleDone = false;
      this.render(x, y, n, params, on);
    }
    for (let c = 1; c < out.length; c++) out[c].set(y);
    return this.alive;
  }

  /** The usual case: compute a wet sample, crossfade it against the dry. */
  blend(dry, wet, on) {
    this.mix += (on - this.mix) * this.aMix;
    return dry + (wet - dry) * this.mix;
  }
}

const P = (name, def = 0.5) => ({ name, defaultValue: def, minValue: 0, maxValue: 1, automationRate: 'k-rate' });
const ON = P('on', 0);

/* ------------------------------------------------------------------ */
/* Overdrive: the green one.                                           */
/* ------------------------------------------------------------------ */
//
// What makes a Tube Screamer work in front of a cranked amp is not that it
// clips — it is what it does before clipping. The 720 Hz high-pass in the
// op-amp's feedback leg means only the mids and up get the gain, so the
// bass reaches the amp clean and the amp does not flub. And the output is
// the input PLUS the clipped part, which is why it keeps the note's body.
// Both are modelled; the clip is a symmetric diode pair, so it is odd
// harmonics, and the amp after it supplies the evens.

class Overdrive extends Pedal {
  static get parameterDescriptors() {
    return [ON, P('drive', 0.4), P('tone', 0.5), P('level', 0.5)];
  }

  constructor() {
    super();
    const hi = sampleRate * OS;
    this.rs = new Resampler();
    this.buf = new Float32Array(OS);
    this.aHp = poleAt(720, hi);
    this.aLp = poleAt(6000, hi);
    this.hp = 0; this.lp = 0;
    this.tone = 0;
  }

  idle() { this.rs.reset(); this.hp = this.lp = this.tone = 0; }

  render(x, y, n, params, on) {
    // Audio taper: about 21 dB at minimum to 41 dB at maximum, the range of
    // the real pot.
    const g = 11.9 * Math.pow(10, params.drive[0]);
    const aTone = poleAt(400 * Math.pow(25, params.tone[0]), sampleRate);
    // Trimmed so noon is a few dB over bypass, not eight: measured at +8 dB
    // the first time, which makes stomping it a volume jump before it is a
    // tone change.
    const lev = levelGain(params.level[0]) * 0.45;
    const buf = this.buf;
    for (let i = 0; i < n; i++) {
      const xi = x ? x[i] : 0;
      this.rs.up(xi, buf);
      for (let p = 0; p < OS; p++) {
        const v = buf[p];
        this.hp += (v - this.hp) * this.aHp;
        // Inside the oversampled region, both halves: if the clean term were
        // added back at the base rate it would be ~16 samples ahead of the
        // clipped one and comb-filter the whole signal.
        let w = v + 0.55 * clip(((v - this.hp) * g) / 0.55, 2.2);
        this.lp += (w - this.lp) * this.aLp;
        buf[p] = this.lp;
      }
      const d = this.rs.down(buf);
      this.tone += (d - this.tone) * aTone;
      y[i] = this.blend(xi, this.tone * lev, on);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Fuzz: a Big Muff, more or less.                                     */
/* ------------------------------------------------------------------ */
//
// Two clipping stages in series, hard enough to square the wave off, and
// then the tone control that makes a Muff a Muff: not an EQ but a blend
// between a low-pass and a high-pass, so at noon the mids fall into the gap
// between them. That scoop is the sound.

class Fuzz extends Pedal {
  static get parameterDescriptors() {
    return [ON, P('fuzz', 0.6), P('tone', 0.5), P('level', 0.5)];
  }

  constructor() {
    super();
    const hi = sampleRate * OS;
    this.rs = new Resampler();
    this.buf = new Float32Array(OS);
    this.aIn = poleAt(90, hi);
    this.aMid = poleAt(1800, hi);
    this.aLo = poleAt(550, sampleRate);
    this.aHi = poleAt(1300, sampleRate);
    this.inHp = 0; this.mid = 0; this.lo = 0; this.hiLp = 0;
  }

  idle() { this.rs.reset(); this.inHp = this.mid = this.lo = this.hiLp = 0; }

  render(x, y, n, params, on) {
    const f = params.fuzz[0];
    const g1 = 6 + f * 70;
    const g2 = 3 + f * 18;
    const t = params.tone[0];
    const lev = levelGain(params.level[0]) * 0.45;
    const buf = this.buf;
    for (let i = 0; i < n; i++) {
      const xi = x ? x[i] : 0;
      this.rs.up(xi, buf);
      for (let p = 0; p < OS; p++) {
        let v = buf[p];
        this.inHp += (v - this.inHp) * this.aIn;
        v = clip((v - this.inHp) * g1, 4);
        this.mid += (v - this.mid) * this.aMid;    // interstage rolloff
        buf[p] = clip(this.mid * g2, 4.5);
      }
      const d = this.rs.down(buf);
      this.lo += (d - this.lo) * this.aLo;
      this.hiLp += (d - this.hiLp) * this.aHi;
      const tone = this.lo * (1 - t) + (d - this.hiLp) * t;
      y[i] = this.blend(xi, tone * lev, on);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Compressor                                                          */
/* ------------------------------------------------------------------ */
//
// The thing to get right is the attack. A compressor in front of an amp is
// for sustain, and the way it sounds like anything is by letting the pick
// through and then squashing the tail, so the note blooms. One that grabs
// the transient just makes everything quieter. Attack runs from 1 to 40 ms;
// the default sits where the pick survives.

class Compressor extends Pedal {
  static get parameterDescriptors() {
    return [ON, P('sustain', 0.5), P('attack', 0.45), P('level', 0.5)];
  }

  constructor() {
    super();
    this.env = 0;
    this.aRel = 1 - Math.exp(-1 / (0.25 * sampleRate));
  }

  idle() { this.env = 0; }

  render(x, y, n, params, on) {
    const thr = -12 - params.sustain[0] * 30;          // dBFS
    const ratio = 8;
    const slope = 1 - 1 / ratio;
    // Auto makeup, so turning sustain up raises the quiet parts rather than
    // only lowering the loud ones.
    const makeup = -thr * slope * 0.55;
    const atkMs = 1 * Math.pow(40, params.attack[0]);
    const aAtk = 1 - Math.exp(-1 / ((atkMs / 1000) * sampleRate));
    const lev = levelGain(params.level[0]);
    for (let i = 0; i < n; i++) {
      const xi = x ? x[i] : 0;
      const a = Math.abs(xi);
      this.env += (a - this.env) * (a > this.env ? aAtk : this.aRel);
      const envDb = 20 * Math.log10(this.env + 1e-9);
      const gr = envDb > thr ? (envDb - thr) * slope : 0;
      y[i] = this.blend(xi, xi * dbGain(makeup - gr) * lev, on);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Wah                                                                 */
/* ------------------------------------------------------------------ */
//
// A resonant band-pass swept by the treadle, roughly 350 Hz to 2.3 kHz,
// with the Q rising as it goes up the way an inductor wah's does. A little
// low-pass is kept under the peak so the heel position still has body.
//
// The treadle is smoothed per sample. Driven from an expression pedal it
// arrives as 128 steps, and a band-pass with a Q of 8 makes each of those
// steps audible as a tiny click unless something rounds them off.
//
// Zavalishin's topology-preserving SVF: stable right up to Nyquist with the
// cutoff moving every sample, which a textbook Chamberlin is not.

class Wah extends Pedal {
  static get parameterDescriptors() {
    return [ON, P('pedal', 0.5), P('q', 0.5), P('level', 0.5)];
  }

  constructor() {
    super();
    this.ic1 = 0; this.ic2 = 0;
    this.pos = 0.5;
    this.aPos = 1 - Math.exp(-1 / (0.012 * sampleRate));
  }

  idle() { this.ic1 = this.ic2 = 0; }

  render(x, y, n, params, on) {
    const target = params.pedal[0];
    const qBase = 2 + params.q[0] * 8;
    const lev = levelGain(params.level[0]);
    for (let i = 0; i < n; i++) {
      const xi = x ? x[i] : 0;
      this.pos += (target - this.pos) * this.aPos;
      const fc = 350 * Math.pow(2300 / 350, this.pos);
      const Q = qBase * (0.75 + 0.5 * this.pos);
      const g = Math.tan((Math.PI * fc) / sampleRate);
      const k = 1 / Q;
      const a1 = 1 / (1 + g * (g + k));
      const a2 = g * a1;
      const a3 = g * a2;
      const v3 = xi - this.ic2;
      const v1 = a1 * this.ic1 + a2 * v3;
      const v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
      this.ic1 = 2 * v1 - this.ic1;
      this.ic2 = 2 * v2 - this.ic2;
      // k*v1 is the unity-peak band-pass. The gain makes up for what the
      // narrow band throws away, so engaging the wah is not a volume drop.
      const wet = (k * v1 * 2.4 + v2 * 0.22) * lev;
      y[i] = this.blend(xi, wet, on);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Boost                                                               */
/* ------------------------------------------------------------------ */
//
// Clean gain with a tilt. In front of a cranked amp it is more drive
// without more fizz; after the cab it is a solo level. The obvious thing to
// put on a footswitch. Linear on purpose — a boost that colours the sound is
// an overdrive, and there is one of those already.

class Boost extends Pedal {
  static get parameterDescriptors() {
    return [ON, P('gain', 0.4), P('tone', 0.5)];
  }

  constructor() {
    super();
    this.aSplit = poleAt(800, sampleRate);
    this.aHp = poleAt(70, sampleRate);
    this.lo = 0; this.hp = 0;
  }

  idle() { this.lo = this.hp = 0; }

  render(x, y, n, params, on) {
    const g = dbGain(params.gain[0] * 20);
    const tilt = (params.tone[0] - 0.5) * 12;          // -6..+6 dB
    const gLo = dbGain(-tilt / 2), gHi = dbGain(tilt / 2);
    for (let i = 0; i < n; i++) {
      const xi = x ? x[i] : 0;
      this.hp += (xi - this.hp) * this.aHp;
      const v = xi - this.hp;                          // a little bass trimmed, like the real ones
      this.lo += (v - this.lo) * this.aSplit;
      y[i] = this.blend(xi, (this.lo * gLo + (v - this.lo) * gHi) * g, on);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Phaser                                                              */
/* ------------------------------------------------------------------ */
//
// Six first-order all-pass stages swept together and summed back against
// the dry signal: wherever the chain has turned the phase by 180 degrees
// the two cancel, which gives three notches moving up and down the
// spectrum. Feedback around the chain sharpens them into peaks — the
// "resonance" that separates a phaser from a polite one.

class Phaser extends Pedal {
  static get parameterDescriptors() {
    return [ON, P('rate', 0.35), P('depth', 0.7), P('feedback', 0.4)];
  }

  constructor() {
    super();
    this.N = 6;
    this.xs = new Float32Array(this.N);
    this.ys = new Float32Array(this.N);
    this.ph = 0;
    this.last = 0;
  }

  idle() { this.xs.fill(0); this.ys.fill(0); this.last = 0; }

  render(x, y, n, params, on) {
    const hz = 0.05 * Math.pow(160, params.rate[0]);
    const inc = (2 * Math.PI * hz) / sampleRate;
    const depth = params.depth[0];
    const fb = params.feedback[0] * 0.75;
    const N = this.N, xs = this.xs, ys = this.ys;
    for (let i = 0; i < n; i++) {
      const xi = x ? x[i] : 0;
      this.ph += inc;
      if (this.ph > 2 * Math.PI) this.ph -= 2 * Math.PI;
      // Exponential sweep, so it spends equal time in each octave.
      const sweep = 0.5 + 0.5 * Math.sin(this.ph);
      const fc = 220 * Math.pow(10, depth * 1.1 * sweep);
      const t = Math.tan((Math.PI * Math.min(fc, sampleRate * 0.45)) / sampleRate);
      const a = (t - 1) / (t + 1);
      let v = xi + this.last * fb;
      for (let s = 0; s < N; s++) {
        const out = a * v + xs[s] - a * ys[s];
        xs[s] = v; ys[s] = out;
        v = out;
      }
      if (Math.abs(v) < 1e-20) v = 0;
      this.last = v;
      y[i] = this.blend(xi, (xi + v) * 0.5 * 1.4, on);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Volume                                                              */
/* ------------------------------------------------------------------ */
//
// Mostly here to be put under an expression pedal: swells. Audio taper, and
// smoothed for the same 128-step reason as the wah. Before the amp it does
// what the guitar's own volume knob does — changes how hard the amp is hit —
// and after the cab it is just level.

class Volume extends Pedal {
  static get parameterDescriptors() {
    return [ON, P('pedal', 1)];
  }

  constructor() {
    super();
    this.g = 1;
    this.aG = 1 - Math.exp(-1 / (0.01 * sampleRate));
  }

  render(x, y, n, params, on) {
    const p = params.pedal[0];
    const target = p * p * p;
    for (let i = 0; i < n; i++) {
      const xi = x ? x[i] : 0;
      this.g += (target - this.g) * this.aG;
      y[i] = this.blend(xi, xi * this.g, on);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Chorus                                                              */
/* ------------------------------------------------------------------ */
//
// Two voices on short modulated delays, their LFOs a quarter cycle apart so
// the detuning never collapses to nothing at once. Hermite interpolation on
// the read: linear interpolation on a moving delay is a low-pass that comes
// and goes with the LFO, which is audible as the chorus dulling the top.

class Chorus extends Pedal {
  static get parameterDescriptors() {
    return [ON, P('rate', 0.35), P('depth', 0.5), P('mix', 0.7)];
  }

  constructor() {
    super();
    this.buf = new Float32Array(Math.ceil(sampleRate * 0.06));
    this.w = 0;
    this.ph = 0;
  }

  idle() { this.buf.fill(0); }

  render(x, y, n, params, on) {
    const hz = 0.05 * Math.pow(100, params.rate[0]);
    const inc = (2 * Math.PI * hz) / sampleRate;
    const depth = params.depth[0] * 0.004 * sampleRate;
    const b1 = 0.008 * sampleRate, b2 = 0.0115 * sampleRate;
    const m = params.mix[0];
    const dryG = Math.cos((m * Math.PI) / 4), wetG = Math.sin((m * Math.PI) / 4);
    const buf = this.buf, len = buf.length;
    for (let i = 0; i < n; i++) {
      const xi = x ? x[i] : 0;
      buf[this.w] = xi;
      this.ph += inc;
      if (this.ph > 2 * Math.PI) this.ph -= 2 * Math.PI;
      const v1 = readHermite(buf, this.w, b1 + depth * (0.5 + 0.5 * Math.sin(this.ph)));
      const v2 = readHermite(buf, this.w, b2 + depth * (0.5 + 0.5 * Math.sin(this.ph + Math.PI / 2)));
      this.w = (this.w + 1) % len;
      const wet = xi * dryG + (v1 + v2) * 0.5 * wetG * 1.414;
      y[i] = this.blend(xi, wet, on);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Tremolo                                                             */
/* ------------------------------------------------------------------ */
//
// Amplitude, with a shape control from a smooth sine to the hard chop of an
// optical tremolo. The shape is a soft clip of the sine rather than a
// different waveform, so turning it is continuous.

class Tremolo extends Pedal {
  static get parameterDescriptors() {
    return [ON, P('rate', 0.5), P('depth', 0.6), P('shape', 0.3)];
  }

  constructor() {
    super();
    this.ph = 0;
  }

  render(x, y, n, params, on) {
    const hz = 0.5 * Math.pow(24, params.rate[0]);
    const inc = (2 * Math.PI * hz) / sampleRate;
    const depth = params.depth[0];
    const k = 1 + params.shape[0] * 9;
    const norm = Math.tanh(k);
    for (let i = 0; i < n; i++) {
      const xi = x ? x[i] : 0;
      this.ph += inc;
      if (this.ph > 2 * Math.PI) this.ph -= 2 * Math.PI;
      const s = Math.tanh(k * Math.sin(this.ph)) / norm;     // -1..1
      const g = 1 - depth * (1 - s) * 0.5;
      y[i] = this.blend(xi, xi * g, on);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Delay                                                               */
/* ------------------------------------------------------------------ */
//
// One delay with the three characters folded into two knobs: Tone darkens
// each repeat a little more than the last, which is what an analogue bucket
// brigade does, and Mod adds the slow wow and fast flutter of tape, so
// repeats drift in pitch. Both at zero is a clean digital delay.
//
// The delay time is smoothed rather than jumped, over about 80 ms. Turning
// the Time knob on a tape echo bends the pitch of what is already in the
// loop, and doing the same here is both the authentic behaviour and the
// click-free one.
//
// Feedback goes slightly past unity on purpose — self-oscillation is a sound
// people use — and a soft clipper in the loop keeps it from running away.
//
// Switching it off stops new input entering the loop and lets the repeats
// already in it ring out.

class Delay extends Pedal {
  static get parameterDescriptors() {
    return [ON, P('time', 0.5), P('feedback', 0.35), P('mix', 0.35),
      P('tone', 0.5), P('mod', 0.15)];
  }

  constructor() {
    super();
    this.buf = new Float32Array(Math.ceil(sampleRate * 2.5));
    this.w = 0;
    this.d = 0.2 * sampleRate;
    this.aD = 1 - Math.exp(-1 / (0.08 * sampleRate));
    this.lp = 0;
    this.feed = 0;
    this.aFeed = 1 - Math.exp(-1 / (0.006 * sampleRate));
    this.hold = 0;
    this.wow = 0; this.flut = 0;
  }

  // Is anything still in the loop? Not "was the output loud recently" —
  // that was the first version, and it cut tails: between two repeats of a
  // short note the output is silent for a whole delay period, a recent-level
  // detector decays to nothing, the pedal decides it is finished and clears
  // its buffer with repeats still in it. So instead, anything audible written
  // into the loop holds the pedal open for one full delay length plus a
  // margin, and every repeat renews it.
  trails() { return this.hold > 0; }

  idle() { this.buf.fill(0); this.lp = 0; this.hold = 0; }

  render(x, y, n, params, on) {
    const ms = 40 * Math.pow(30, params.time[0]);
    const target = (ms / 1000) * sampleRate;
    const fb = params.feedback[0] * 1.1;
    const mix = params.mix[0];
    const aTone = poleAt(1000 * Math.pow(12, params.tone[0]), sampleRate);
    const mod = params.mod[0];
    const wowInc = (2 * Math.PI * 0.55) / sampleRate;
    const flutInc = (2 * Math.PI * 6.3) / sampleRate;
    const buf = this.buf, len = buf.length;
    for (let i = 0; i < n; i++) {
      const xi = x ? x[i] : 0;
      this.d += (target - this.d) * this.aD;
      this.wow += wowInc; this.flut += flutInc;
      if (this.wow > 6.283185307) this.wow -= 6.283185307;
      if (this.flut > 6.283185307) this.flut -= 6.283185307;
      const wobble = mod * sampleRate * (0.0014 * Math.sin(this.wow) + 0.00018 * Math.sin(this.flut));
      const r = readHermite(buf, this.w, Math.max(4, this.d + wobble));
      this.lp += (r - this.lp) * aTone;
      if (Math.abs(this.lp) < 1e-20) this.lp = 0;
      this.feed += (on - this.feed) * this.aFeed;
      const loop = this.lp * fb;
      // A cheap tanh, so self-oscillation saturates instead of exploding.
      const sat = loop * (27 + loop * loop) / (27 + 9 * loop * loop);
      const wr = xi * this.feed + Math.max(-1.5, Math.min(1.5, sat));
      buf[this.w] = wr;
      this.w = (this.w + 1) % len;
      if (Math.abs(wr) > 1e-4) this.hold = this.d + 4096;
      else if (this.hold > 0) this.hold--;
      y[i] = xi + this.lp * mix;
    }
    this.mix = this.feed;
  }
}

/* ------------------------------------------------------------------ */
/* Reverb: a room to a hall, in a pedal.                               */
/* ------------------------------------------------------------------ */
//
// Eight delay lines feeding back into each other through a Hadamard matrix
// (a feedback delay network), after four allpasses that smear the attack so
// the first reflections are a wash rather than a flam. Decay sets each
// line's loss for the time the tail takes to fall 60 dB. Tone is a low-pass
// inside the loop, so the top dies first, as it does in a real space. Size
// scales every line together, from a small room to a hall. Pre-delay holds
// the wash back so the note speaks first. Two lines drift slowly: a network
// this small rings metallic on a held note without it.
//
// Mono, like the rest of the board, and it rings out when switched off.

// Line lengths at Size 1, in seconds: no two share a factor worth hearing.
const VERB_LINES = [0.0297, 0.0371, 0.0411, 0.0437, 0.0533, 0.0599, 0.0677, 0.0793];
const VERB_DIFFUSE = [0.00477, 0.00359, 0.01273, 0.00931];
const VERB_HALF = 1 / Math.sqrt(8);

class Reverb extends Pedal {
  static get parameterDescriptors() {
    return [ON, P('mix', 0.3), P('decay', 0.45), P('tone', 0.5), P('size', 0.6), P('predelay', 0.2)];
  }

  constructor() {
    super();
    const cap = Math.ceil(sampleRate * 0.12);
    this.lines = VERB_LINES.map(() => new Float32Array(cap));
    this.lp = new Float64Array(8);
    this.v = new Float64Array(8);
    this.g = new Float64Array(8);
    this.ap = VERB_DIFFUSE.map((t) => new Float32Array(Math.round(t * sampleRate)));
    this.apW = [0, 0, 0, 0];
    this.pre = new Float32Array(Math.ceil(sampleRate * 0.16));
    this.w = 0;
    this.pw = 0;
    this.scale = 0.95;
    this.pd = 0.03 * sampleRate;
    this.aD = 1 - Math.exp(-1 / (0.08 * sampleRate));
    this.feed = 0;
    this.aFeed = 1 - Math.exp(-1 / (0.006 * sampleRate));
    this.hold = 0;
    this.lfo1 = 0; this.lfo2 = 0;
  }

  trails() { return this.hold > 0; }

  idle() {
    for (const l of this.lines) l.fill(0);
    for (const a of this.ap) a.fill(0);
    this.pre.fill(0);
    this.lp.fill(0);
    this.hold = 0;
  }

  render(x, y, n, params, on) {
    const mix = params.mix[0];
    const rt60 = 0.25 * Math.pow(40, params.decay[0]);
    const aTone = poleAt(1200 * Math.pow(10, params.tone[0]), sampleRate);
    const scaleTarget = 0.35 + params.size[0];
    const pdTarget = 0.15 * params.predelay[0] * sampleRate;
    // Each line's loss for one trip around it, at the size it is now.
    const g = this.g;
    for (let k = 0; k < 8; k++) g[k] = Math.pow(10, (-3 * VERB_LINES[k] * this.scale) / rt60);
    const inc1 = (2 * Math.PI * 0.53) / sampleRate, inc2 = (2 * Math.PI * 0.71) / sampleRate;
    const depth = 0.0003 * sampleRate;
    const { lines, lp, v, ap, apW, pre } = this;
    const cap = lines[0].length;
    for (let i = 0; i < n; i++) {
      const xi = x ? x[i] : 0;
      this.feed += (on - this.feed) * this.aFeed;
      this.scale += (scaleTarget - this.scale) * this.aD;
      this.pd += (pdTarget - this.pd) * this.aD;
      this.lfo1 += inc1; this.lfo2 += inc2;
      if (this.lfo1 > 6.283185307) this.lfo1 -= 6.283185307;
      if (this.lfo2 > 6.283185307) this.lfo2 -= 6.283185307;

      // Pre-delay, then the diffusers.
      let d = readHermite(pre, this.pw, Math.max(4, this.pd));
      pre[this.pw] = xi * this.feed;
      this.pw = (this.pw + 1) % pre.length;
      for (let k = 0; k < 4; k++) {
        const b = ap[k], r = b[apW[k]];
        const u = d - 0.62 * r;
        b[apW[k]] = u;
        apW[k] = (apW[k] + 1) % b.length;
        d = r + 0.62 * u;
      }

      // The network: read every line, darken, lose, mix, write back.
      for (let k = 0; k < 8; k++) {
        let len = VERB_LINES[k] * this.scale * sampleRate;
        if (k === 2) len += depth * Math.sin(this.lfo1);
        else if (k === 5) len += depth * Math.sin(this.lfo2);
        const r = readHermite(lines[k], this.w, len);
        lp[k] += (r - lp[k]) * aTone;
        if (Math.abs(lp[k]) < 1e-20) lp[k] = 0;
        v[k] = lp[k] * g[k];
      }
      for (let h = 1; h < 8; h *= 2) {
        for (let j = 0; j < 8; j += 2 * h) {
          for (let k = j; k < j + h; k++) {
            const a = v[k], b = v[k + h];
            v[k] = a + b;
            v[k + h] = a - b;
          }
        }
      }
      for (let k = 0; k < 8; k++) lines[k][this.w] = v[k] * VERB_HALF + d * 0.5;
      this.w = (this.w + 1) % cap;

      const wet = (lp[0] - lp[1] + lp[2] - lp[3] + lp[4] - lp[5] + lp[6] - lp[7]) * 1.1;
      if (Math.abs(wet) > 1e-5) this.hold = 2048;
      else if (this.hold > 0) this.hold--;
      y[i] = xi + wet * mix;
    }
    this.mix = this.feed;
  }
}

registerProcessor('pedal-overdrive', Overdrive);
registerProcessor('pedal-fuzz', Fuzz);
registerProcessor('pedal-comp', Compressor);
registerProcessor('pedal-wah', Wah);
registerProcessor('pedal-boost', Boost);
registerProcessor('pedal-phaser', Phaser);
registerProcessor('pedal-volume', Volume);
registerProcessor('pedal-chorus', Chorus);
registerProcessor('pedal-tremolo', Tremolo);
registerProcessor('pedal-delay', Delay);
registerProcessor('pedal-reverb', Reverb);
