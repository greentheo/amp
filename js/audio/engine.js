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

  async init() {
    if (this.ctx) return;
    // 'interactive' is the whole difference between an amp you can play and a
    // thing that answers you a fifth of a second later.
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule('js/audio/amp-worklet.js');

    this.preIn = ctx.createGain();     // the engine socket: in
    this.preOut = ctx.createGain();    // and out

    this.amp = new AudioWorkletNode(ctx, 'amp-processor', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    });
    this.amp.port.onmessage = (e) => { if (this.onMeter) this.onMeter(e.data); };
    this.preIn.connect(this.amp).connect(this.preOut);

    this.cab = ctx.createConvolver();
    this.cab.normalize = false;
    this.cabWet = ctx.createGain();
    this.cabDry = ctx.createGain();
    this.cabDry.gain.value = 0;
    this.preOut.connect(this.cab).connect(this.cabWet);
    this.preOut.connect(this.cabDry);

    this.sum = ctx.createGain();
    this.cabWet.connect(this.sum);
    this.cabDry.connect(this.sum);

    this.master = ctx.createGain();
    this.master.gain.value = 0.8;

    // Send and return, with the return landing downstream of the send. Wiring
    // it back into `sum` makes a feedback loop that smears and builds instead
    // of decaying.
    this.verb = ctx.createConvolver();
    this.verbSend = ctx.createGain();
    this.verbSend.gain.value = 0.12;
    this.verb.buffer = this.springIR();
    this.sum.connect(this.verbSend).connect(this.verb).connect(this.master);
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2;
    this.limiter.ratio.value = 14;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.18;
    this.sum.connect(this.master);
    this.master.connect(this.limiter).connect(ctx.destination);

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
  springIR() {
    const rate = this.ctx.sampleRate;
    const len = Math.round(rate * 1.4);
    const buf = this.ctx.createBuffer(2, len, rate);
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
