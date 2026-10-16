// The amp itself: everything that has to happen sample by sample.
//
//   gate -> [4x up] -> stage 1 -> stage 2 -> tone stack -> stage 3
//                   -> power amp (push-pull + sag) -> presence -> [4x down]
//
// Why one worklet rather than a graph of nodes: cascaded nonlinearities have
// to share an oversampled region. Four gain stages built from WaveShaperNodes
// resample four times over, and the distortion each one makes still folds back
// down before it reaches the next. Here the signal goes up once, gets mangled
// at 4x, and comes down once.
//
// Everything is deliberately modest in cost. A guitar amp has to run at a
// latencyHint of 'interactive' without glitching, which is a much tighter
// budget than an ambient pad has.

/**
 * The preamp's voicing: the numbers that decide how hard each stage is
 * driven and how each valve clips.
 *
 * These were constants in the code until there was a way to measure them.
 * They are data now because calibrating against a reference means fitting
 * them, and you cannot fit a literal buried three levels into a loop. The
 * defaults below are what the amp shipped with.
 *
 *   drive -> gain:  10^(drive * decades) * scale    into stage 1
 *   later stages:   stageGain + g * stageGainDrive
 *   makeup:         applied after the tone stack, which sits mid-preamp
 *   stages[]:       [coupling-cap Hz, Miller Hz, kp, kn] per stage
 *
 * kp and kn are the two halves of the valve curve — grid conduction one
 * side, cutoff the other. Their *difference* is where even harmonics come
 * from, and their size sets how early it saturates: tube() tends to 1/kp
 * going up and -1/kn going down.
 */
const VOICING = {
  decades: 2.2,
  scale: 0.9,
  // 'exp' is the shipped exponential curve; 'soft' decouples knee hardness
  // from saturation point. knee only applies to 'soft'.
  curve: 'exp',
  knee: 2.0,
  stageGain: 1.6,
  stageGainDrive: 0.08,
  makeup: 3.2,
  stages: [
    [14, 12000, 1.0, 0.7],
    [30, 10000, 1.1, 0.6],
    [60, 9000, 1.2, 0.55],
    [90, 8000, 1.3, 0.5],
  ],
};

const OS = 4;            // oversampling factor
// Where the up/down filters turn over, in Hz at the base rate.
//
// The instinct is to put this just under Nyquist and keep everything. That is
// a trap: a windowed sinc's transition band is about 5.5/N wide, so a 32-tap
// filter cornering at 21 kHz does not reach its stopband until nearly 38 kHz
// — and the 4th through 9th harmonics of anything in the top octave sit in
// that gap and fold straight back down. More taps at the same corner does not
// help, and neither does more oversampling, because the content being folded
// was never above the oversampled Nyquist in the first place.
//
// So corner it low enough that the stopband starts before the base Nyquist.
// 11 kHz costs nothing here: the speaker cabinet is already 30 dB down by
// 8 kHz, and no guitar amp ever made has anything to say up there.
const CUT_HZ = 11000;
const TAPS = 16 * OS;

/** Windowed sinc, normalised to unity gain at DC. */
function designTaps(n, cutoff) {
  const h = new Float32Array(n);
  const c = (n - 1) / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = i - c;
    const sinc = Math.abs(x) < 1e-9
      ? 2 * cutoff
      : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
      + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= sum;
  return h;
}

/**
 * A triode stage, viewed from the plate. The two halves clip differently —
 * grid conduction on one side, cutoff on the other — and that asymmetry is
 * where the even harmonics come from. A symmetric clipper sounds like a fuzz
 * pedal; this is the difference between "distorted" and "valve".
 */
function tube(x, kp, kn) {
  return x >= 0 ? (1 - Math.exp(-kp * x)) / kp : -(1 - Math.exp(kn * x)) / kn;
}

/**
 * The same asymmetry, but with the knee's hardness separated from where it
 * saturates.
 *
 *   f(x) = x / (1 + |k x|^h)^(1/h)
 *
 * Measured against BIAS, `tube` above could not be made to fit, and the
 * reason turned out to be its shape rather than its numbers: an exponential
 * is curved everywhere, so the same kp that keeps it linear enough at -30
 * dBFS also makes it too soft to generate the 3rd harmonic a real preamp
 * makes at -6. Sweeping kp and kn across fifteen combinations moved the
 * harmonic error by 0.35 dB out of 12 — the parameters were already as good
 * as that family gets.
 *
 * This form has what that one lacks: for small x it is linear to within
 * |kx|^h, so it is genuinely clean when it is quiet, and h sets how abruptly
 * it turns over without moving the threshold. h=1 is hyperbolic and soft,
 * h=8 is nearly a hard clip at 1/k.
 *
 * IT DID NOT HELP, and that is why it is not the default. Swept across knee
 * hardness, saturation and asymmetry it reached 11.39 dB against BIAS where
 * the exponential reached 11.65 — a quarter of a dB — and the search wanted
 * the softest knee offered, which is the exponential's own behaviour. So the
 * residual is not the preamp's curve shape.
 *
 * It is kept, off by default, because the next person to look at that 11 dB
 * will have this idea too and should not have to spend an afternoon finding
 * out. The remaining suspect is the power amp: it is the one nonlinearity in
 * the chain that is still hardcoded, still symmetric, and still exponential,
 * and the harmonic measurement cannot tell its products from the preamp's.
 */
function softTube(x, kp, kn, h) {
  const k = x >= 0 ? kp : kn;
  const a = Math.abs(k * x);
  return x / Math.pow(1 + Math.pow(a, h), 1 / h);
}

/** One-pole smoothing coefficient for a corner frequency. */
function poleAt(hz, rate) {
  return 1 - Math.exp((-2 * Math.PI * hz) / rate);
}

class Stage {
  /**
   * @param {number} hpHz coupling cap — how much low end reaches the grid.
   *   This is "tightness": raise it and the amp stops flubbing under gain.
   * @param {number} lpHz Miller capacitance rolling the top off each stage.
   */
  constructor(rate, hpHz, lpHz, kp, kn, curve = 'exp', knee = 2.0) {
    this.aHp = poleAt(hpHz, rate);
    this.aLp = poleAt(lpHz, rate);
    this.aDc = poleAt(8, rate);
    this.hp = 0; this.lp = 0; this.dc = 0;
    this.kp = kp; this.kn = kn;
    this.soft = curve === 'soft';
    this.knee = knee;
  }

  run(x, gain, bias) {
    this.hp += (x - this.hp) * this.aHp;
    const u = (x - this.hp) * gain + bias;
    let y = this.soft ? softTube(u, this.kp, this.kn, this.knee)
      : tube(u, this.kp, this.kn);
    this.lp += (y - this.lp) * this.aLp;
    y = this.lp;
    // Asymmetric clipping shifts the average, and that offset would be
    // amplified by every stage after it.
    this.dc += (y - this.dc) * this.aDc;
    return y - this.dc;
  }
}

class AmpProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'drive',    defaultValue: 0.35, minValue: 0,   maxValue: 1, automationRate: 'k-rate' },
      { name: 'bias',     defaultValue: 0.0,  minValue: -0.5, maxValue: 0.5, automationRate: 'k-rate' },
      { name: 'presence', defaultValue: 0.3,  minValue: 0,   maxValue: 1, automationRate: 'k-rate' },
      { name: 'sag',      defaultValue: 0.3,  minValue: 0,   maxValue: 1, automationRate: 'k-rate' },
      { name: 'masterVol',defaultValue: 0.5,  minValue: 0,   maxValue: 1, automationRate: 'k-rate' },
      { name: 'gate',     defaultValue: 0.0,  minValue: 0,   maxValue: 1, automationRate: 'k-rate' },
      { name: 'stages',   defaultValue: 3,    minValue: 1,   maxValue: 4, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    const rate = sampleRate;
    const hi = rate * OS;

    this.h = designTaps(TAPS, CUT_HZ / (sampleRate * OS));
    // Polyphase branches for the upsampler: three of every four input samples
    // would be zero, and multiplying by them is work for nothing.
    this.phases = [];
    for (let p = 0; p < OS; p++) {
      const len = Math.ceil(TAPS / OS);
      const b = new Float32Array(len);
      for (let k = 0; k < len; k++) {
        const idx = k * OS + p;
        b[k] = idx < TAPS ? this.h[idx] * OS : 0;
      }
      this.phases.push(b);
    }
    this.upLine = new Float32Array(Math.ceil(TAPS / OS));
    this.downLine = new Float32Array(TAPS);

    // Progressively darker and tighter as the signal goes down the chain,
    // which is what keeps a high-gain sound from turning to mush.
    this.hi = hi;
    this.voicing = { ...VOICING, stages: VOICING.stages.map((s) => s.slice()) };
    this.buildStages();

    // Tone stack: coefficients come from the main thread, because getting
    // them right is circuit analysis and belongs in one testable place.
    // Only the difference equation lives here.
    this.ts = null;
    this.tsState = [0, 0, 0];

    this.ampHp = 0; this.ampLp = 0;
    this.aAmpHp = poleAt(28, hi);     // output transformer losing the bottom
    this.aAmpLp = poleAt(7500, hi);   // and the top
    this.presLp = 0;
    this.aPres = poleAt(2000, hi);
    this.sagEnv = 0;
    this.aSagUp = poleAt(14, hi);
    this.aSagDn = poleAt(2.5, hi);
    this.gateEnv = 0;
    this.aGate = poleAt(20, rate);
    this.gateOpen = 0;
    this.outPeak = 0;
    this.frame = 0;
    this.alive = true;

    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'tone') this.ts = d.k;
      else if (d.type === 'voicing') this.setVoicing(d.v);
      else if (d.type === 'stop') this.alive = false;
    };
  }

  buildStages() {
    this.stages = this.voicing.stages.map(
      ([hp, lp, kp, kn]) => new Stage(this.hi, hp, lp, kp, kn,
        this.voicing.curve, this.voicing.knee));
  }

  /** Merge a partial voicing and rebuild, or reset to stock with null.
   *  Partial so a fit can move one number without restating the rest. */
  setVoicing(v) {
    if (!v) {
      this.voicing = { ...VOICING, stages: VOICING.stages.map((r) => r.slice()) };
      this.buildStages();
      return;
    }
    const next = { ...this.voicing, ...v };
    if (v.stages) {
      next.stages = this.voicing.stages.map((row, i) =>
        (v.stages[i] ? row.map((x, j) => (v.stages[i][j] == null ? x : v.stages[i][j])) : row.slice()));
    }
    this.voicing = next;
    this.buildStages();
  }

  upsample(x, out) {
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

  downsample(buf) {
    const line = this.downLine;
    for (let i = TAPS - 1; i >= OS; i--) line[i] = line[i - OS];
    for (let p = 0; p < OS; p++) line[OS - 1 - p] = buf[p];
    let acc = 0;
    for (let i = 0; i < TAPS; i++) acc += this.h[i] * line[i];
    return acc;
  }

  process(inputs, outputs, params) {
    const inp = inputs[0];
    const out = outputs[0];
    if (!out || !out.length) return this.alive;
    const src = inp && inp.length ? inp[0] : null;
    const dst = out[0];
    const n = dst.length;

    const drive = params.drive[0];
    const bias = params.bias[0];
    const presence = params.presence[0];
    const sagAmt = params.sag[0];
    const master = params.masterVol[0];
    const gateThresh = params.gate[0];
    const nStages = Math.max(1, Math.min(4, Math.round(params.stages[0])));

    // Three decades of gain across the knob, which is roughly what the span
    // from "clean" to "all the way up" actually is.
    const V = this.voicing;
    const g = Math.pow(10, drive * V.decades) * V.scale;
    const buf = new Float32Array(OS);
    let peak = 0;

    for (let i = 0; i < n; i++) {
      let x = src ? src[i] : 0;

      // Noise gate. A high-gain amp amplifies the hum between notes as
      // enthusiastically as it amplifies the notes.
      const a = Math.abs(x);
      this.gateEnv += (a - this.gateEnv) * (a > this.gateEnv ? 0.4 : this.aGate);
      if (gateThresh > 0.001) {
        const thr = gateThresh * 0.08;
        const want = this.gateEnv > thr ? 1 : 0;
        this.gateOpen += (want - this.gateOpen) * (want > this.gateOpen ? 0.25 : 0.004);
        x *= this.gateOpen;
      }

      this.upsample(x, buf);

      for (let p = 0; p < OS; p++) {
        let y = buf[p];

        for (let s = 0; s < nStages; s++) {
          y = this.stages[s].run(y, s === 0 ? g : V.stageGain + g * V.stageGainDrive,
            bias * (s + 1) * 0.3);
          // The tone stack sits between the preamp stages, not after them —
          // which is why on a real amp the tone controls change how the amp
          // distorts and not just how it sounds afterwards.
          if (s === 1 && this.ts) y = this.tsStep(y) * V.makeup;
        }

        // Power amp. Push-pull cancels the even harmonics the preamp made,
        // so what comes out the other side is a different flavour of dirt.
        const e = Math.abs(y);
        this.sagEnv += (e - this.sagEnv) * (e > this.sagEnv ? this.aSagUp : this.aSagDn);
        const head = 1 - sagAmt * 0.55 * Math.min(1, this.sagEnv);
        const z = y / Math.max(0.2, head);
        y = (tube(z, 1.0, 1.0) - tube(-z, 1.0, 1.0)) * 0.5 * head;

        this.ampHp += (y - this.ampHp) * this.aAmpHp;
        y -= this.ampHp;
        this.ampLp += (y - this.ampLp) * this.aAmpLp;
        y = this.ampLp;

        // Presence is negative feedback the amp does not apply up top, so it
        // reads as a lift rather than a cut.
        this.presLp += (y - this.presLp) * this.aPres;
        y += (y - this.presLp) * presence * 2.2;

        buf[p] = y;
      }

      let o = this.downsample(buf) * master * 0.42;
      if (!Number.isFinite(o)) { o = 0; this.reset(); }
      o = Math.max(-1.2, Math.min(1.2, o));
      dst[i] = o;
      const m = Math.abs(o);
      if (m > peak) peak = m;
    }

    for (let c = 1; c < out.length; c++) out[c].set(dst);

    this.outPeak = Math.max(peak, this.outPeak * 0.92);
    if ((this.frame++ & 7) === 0) {
      this.port.postMessage({ peak: this.outPeak, gate: this.gateOpen });
    }
    return this.alive;
  }

  /** The tone stack difference equation. Coefficients arrive from the main
   *  thread; this is the only part of it that has to run per sample. */
  tsStep(x) {
    const k = this.ts, s = this.tsState;
    const y = (k.nx * x + s[0] + k.g * (s[1] + k.g * s[2])) * k.dn;
    const z3 = s[2] - k.g * k.al0 * y;
    const z2 = k.g * (k.be1 * x - k.al1 * y + z3) + s[1];
    const z1 = k.g * (k.be2 * x - y + z2) + s[0];
    s[0] = 2 * z1 - s[0];
    s[1] = 2 * z2 - s[1];
    s[2] = 2 * z3 - s[2];
    return y;
  }

  reset() {
    this.tsState = [0, 0, 0];
    this.upLine.fill(0);
    this.downLine.fill(0);
    this.ampHp = this.ampLp = this.presLp = this.sagEnv = 0;
    for (const s of this.stages) { s.hp = s.lp = s.dc = 0; }
  }
}

registerProcessor('amp-processor', AmpProcessor);
