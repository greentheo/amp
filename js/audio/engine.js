// The signal path, and the plumbing around it.
//
//   guitar / DI -> gate+amp (worklet) -> cab (convolver) -> reverb -> master
//
// The amp block is deliberately swappable. Right now it is the analytic
// worklet; a neural engine lands in the same socket later, between `preIn`
// and `preOut`, without anything either side of it knowing.

import { renderCab } from './cab.js';
import { makeDI } from './di.js';
import { coeffs } from './tonestack.js';

export class Engine {
  constructor() {
    this.ctx = null;
    this.amp = null;
    this.stream = null;
    this.onMeter = null;
    this.tone = { stack: 'jcm800', bass: 0.5, mid: 0.5, treble: 0.6 };
  }

  /**
   * Everything between an input and the speakers, built into whichever
   * context is handed in.
   *
   * This is one function rather than inline setup because the calibration
   * render has to go through *exactly* the chain you are listening to. A
   * second copy of the wiring for offline use would drift from this one, and
   * the whole point of a calibration tool is that it measures the real thing.
   *
   * @param {BaseAudioContext} ctx live or offline
   * @returns {object} the named nodes, for the caller to tap into
   */
  buildChain(ctx) {
    const g = {};
    g.preIn = ctx.createGain();      // the engine socket: in
    g.preOut = ctx.createGain();     // and out

    g.amp = new AudioWorkletNode(ctx, 'amp-processor', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    });
    g.preIn.connect(g.amp).connect(g.preOut);

    g.cab = ctx.createConvolver();
    g.cab.normalize = false;
    g.cabWet = ctx.createGain();
    g.cabDry = ctx.createGain();
    g.cabDry.gain.value = 0;
    g.preOut.connect(g.cab).connect(g.cabWet);
    g.preOut.connect(g.cabDry);

    g.sum = ctx.createGain();
    g.cabWet.connect(g.sum);
    g.cabDry.connect(g.sum);

    g.master = ctx.createGain();
    g.master.gain.value = 0.8;

    // Send and return, with the return landing downstream of the send. Wiring
    // it back into `sum` makes a feedback loop that smears and builds instead
    // of decaying.
    g.verb = ctx.createConvolver();
    g.verbSend = ctx.createGain();
    g.verbSend.gain.value = 0.12;
    g.verb.buffer = springIR(ctx);
    g.sum.connect(g.verbSend).connect(g.verb).connect(g.master);

    g.limiter = ctx.createDynamicsCompressor();
    g.limiter.threshold.value = -2;
    g.limiter.ratio.value = 14;
    g.limiter.attack.value = 0.003;
    g.limiter.release.value = 0.18;
    g.sum.connect(g.master);
    g.master.connect(g.limiter);
    return g;
  }

  async init() {
    if (this.ctx) return;
    // 'interactive' is the whole difference between an amp you can play and a
    // thing that answers you a fifth of a second later.
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule('js/audio/amp-worklet.js');

    Object.assign(this, this.buildChain(ctx));
    this.amp.port.onmessage = (e) => { if (this.onMeter) this.onMeter(e.data); };
    this.limiter.connect(ctx.destination);

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.limiter.connect(this.analyser);

    // Nothing is plugged in yet, so give it something to amplify.
    this.di = ctx.createBufferSource();
    this.diGain = ctx.createGain();
    this.diGain.gain.value = 0;
    this.di.buffer = makeDI(ctx, 'riff');
    this.di.loop = true;
    this.di.connect(this.diGain).connect(this.preIn);
    this.di.start();

    await this.setCab({});
    this.setTone(this.tone);
  }

  /** A short bright reverb: an amp's spring tank, roughly. */
  springIR() { return springIR(this.ctx); }

  /**
   * Render a stimulus through the amp offline, at the settings you are
   * hearing right now.
   *
   * This is how the calibration loop gets its "ours" side. Re-recording the
   * page in real time would be fine, but it puts a converter round trip and
   * whatever the OS mixer felt like doing into a measurement whose whole
   * purpose is to be exact — and it takes as long as the stimulus. This is
   * the identical graph, bit-exact, and renders a minute of audio in a
   * second or two.
   *
   * @param {AudioBuffer|ArrayBuffer} input the stimulus
   * @returns {Promise<AudioBuffer>} the amp's output
   */
  async renderStimulus(input) {
    if (!this.ctx) throw new Error('power the amp on first');
    const rate = this.ctx.sampleRate;

    // Decode against the live context so the stimulus lands at the rate the
    // tone stack coefficients were computed for.
    const src = input instanceof ArrayBuffer
      ? await this.ctx.decodeAudioData(input.slice(0))
      : input;

    // A tail, so the reverb and the last decay are not cut off mid-ring.
    const frames = src.length + Math.round(rate * 2);
    const off = new OfflineAudioContext({ numberOfChannels: 1, length: frames, sampleRate: rate });
    await off.audioWorklet.addModule('js/audio/amp-worklet.js');

    const g = this.buildChain(off);
    g.limiter.connect(off.destination);

    // Carry every live setting across. Reading the AudioParams back off the
    // running node is what keeps this honest — there is no second copy of
    // the state to fall out of step.
    for (const [name, param] of this.amp.parameters) {
      const target = g.amp.parameters.get(name);
      if (target) target.value = param.value;
    }
    g.master.gain.value = this.master.gain.value;
    g.verbSend.gain.value = this.verbSend.gain.value;
    g.cabWet.gain.value = this.cabWet.gain.value;
    g.cabDry.gain.value = this.cabDry.gain.value;

    const { stack, treble, mid, bass } = this.tone;
    g.amp.port.postMessage({ type: 'tone', k: coeffs(stack, treble, mid, bass, rate * 4) });

    // AudioBuffers belong to the context that made them, so the cab IR has
    // to be copied rather than shared.
    if (this.cab.buffer) g.cab.buffer = copyBuffer(off, this.cab.buffer);

    const node = off.createBufferSource();
    node.buffer = copyBuffer(off, src);
    node.connect(g.preIn);
    node.start();

    return off.startRendering();
  }

  async setCab(opts) {
    this.cabOpts = { ...(this.cabOpts || { speaker: 'v30', axis: 0.6, distance: 0.25 }), ...opts };
    this.cab.buffer = await renderCab(this.ctx, this.cabOpts);
  }

  /** Drop a measured impulse response in over the generated one. */
  async loadIR(file) {
    const buf = await this.ctx.decodeAudioData(await file.arrayBuffer());
    this.cab.buffer = buf;
    return buf.duration;
  }

  setTone(t) {
    Object.assign(this.tone, t);
    const { stack, treble, mid, bass } = this.tone;
    // 4x, because that is the rate the filter runs at inside the worklet.
    this.amp.port.postMessage({
      type: 'tone', k: coeffs(stack, treble, mid, bass, this.ctx.sampleRate * 4),
    });
  }

  set(name, value) {
    const p = this.amp.parameters.get(name);
    if (p) p.setTargetAtTime(value, this.ctx.currentTime, 0.02);
    else if (name === 'master') this.master.gain.setTargetAtTime(value, this.ctx.currentTime, 0.03);
    else if (name === 'reverb') this.verbSend.gain.setTargetAtTime(value, this.ctx.currentTime, 0.05);
    else if (name === 'cabMix') {
      this.cabWet.gain.setTargetAtTime(value, this.ctx.currentTime, 0.03);
      this.cabDry.gain.setTargetAtTime(1 - value, this.ctx.currentTime, 0.03);
    }
  }

  setDI(on, shape) {
    if (shape && this.ctx) {
      const next = this.ctx.createBufferSource();
      next.buffer = makeDI(this.ctx, shape);
      next.loop = true;
      next.connect(this.diGain);
      try { this.di.stop(); } catch {}
      this.di.disconnect();
      next.start();
      this.di = next;
    }
    this.diGain.gain.setTargetAtTime(on ? 0.55 : 0, this.ctx.currentTime, 0.02);
  }

  async enableInput(deviceId) {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    // Every one of these is built to wreck a guitar signal. Echo cancellation
    // in particular treats a sustained note as feedback and ducks it.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: 1, ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    });
    if (this.src) this.src.disconnect();
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.src.connect(this.preIn);
    return this.stream.getAudioTracks()[0].label;
  }

  /** Round-trip latency in ms, as honestly as the browser will say. */
  latency() {
    if (!this.ctx) return null;
    const base = (this.ctx.baseLatency || 0) * 1000;
    const out = (this.ctx.outputLatency || 0) * 1000;
    return { base, out, total: base + out };
  }

  level() {
    if (!this.analyser) return 0;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
    return peak;
  }

  async resume() {
    if (this.ctx && this.ctx.state !== 'running') await this.ctx.resume();
  }
}

/** A short bright reverb: an amp's spring tank, roughly. */
function springIR(ctx) {
  const rate = ctx.sampleRate;
  const len = Math.round(rate * 1.4);
  const buf = ctx.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const t = i / rate;
      const env = Math.exp(-t * 4.2);
      // The chirp is what makes a spring sound like a spring.
      d[i] = (Math.random() * 2 - 1) * env * 0.5
        + Math.sin(2 * Math.PI * (1400 - 900 * Math.min(1, t)) * t) * env * 0.08;
    }
  }
  return buf;
}

/** Move an AudioBuffer into another context. They are not transferable. */
function copyBuffer(ctx, buf) {
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c), c);
  return out;
}
