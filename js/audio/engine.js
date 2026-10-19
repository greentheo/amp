// The signal path, and the plumbing around it.
//
//   guitar / DI -> [pedals, pre] -> gate+amp (worklet) -> cab (convolver)
//               -> [pedals, post] -> reverb -> master
//
// Where a pedal sits is most of what it does, so there are two lanes. In
// front of the amp a pedal changes how the amp distorts; after the cab it
// only changes what you hear. A delay in front of a high-gain preamp
// distorts its own repeats, which is almost never what anyone wants, and an
// overdrive after the cab is just a fizzy mess — hence the defaults.
//
// The amp block is deliberately swappable. Right now it is the analytic
// worklet; a neural engine lands in the same socket later, between `preIn`
// and `preOut`, without anything either side of it knowing.

import { renderCab } from './cab.js';
import { makeDI } from './di.js';
import { coeffs } from './tonestack.js';
import { PEDAL_TYPES, defaultBoard, findPedal } from './pedals.js';

export class Engine {
  constructor() {
    this.ctx = null;
    this.amp = null;
    this.stream = null;
    this.onMeter = null;
    this.tone = { stack: 'jcm800', bass: 0.5, mid: 0.5, treble: 0.6 };
    // Partial overrides onto the worklet's defaults; empty means stock.
    this.voicing = {};
    // What was last ASKED for, which is not what the AudioParams hold.
    // set() ramps with setTargetAtTime over 20 ms so the knobs do not click,
    // so reading .value straight afterwards returns a number on its way to
    // the target and mostly still the previous setting. An offline render
    // that reads the live params therefore renders the setting before last
    // — which in a sweep looks perfectly monotonic and is quietly off by
    // one step. The render uses these instead.
    this.requested = {};
    // The pedalboard is state like any other: the live graph is built from
    // it, and so is the offline render, so a render is what you hear.
    this.board = defaultBoard();
    this.pedalNodes = new Map();       // uid -> live AudioWorkletNode
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
    // Sources connect to fxPreIn. With no pedals in a lane its in and out
    // are simply joined; buildPedals() splices nodes in between.
    g.fxPreIn = ctx.createGain();
    g.preIn = ctx.createGain();      // the engine socket: in
    g.preOut = ctx.createGain();     // and out
    g.fxPreIn.connect(g.preIn);

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

    g.fxPostIn = ctx.createGain();
    g.fxPostOut = ctx.createGain();
    g.sum.connect(g.fxPostIn);
    g.fxPostIn.connect(g.fxPostOut);

    g.master = ctx.createGain();
    g.master.gain.value = 0.8;

    // Send and return, with the return landing downstream of the send. Wiring
    // it back into `sum` makes a feedback loop that smears and builds instead
    // of decaying.
    g.verb = ctx.createConvolver();
    g.verbSend = ctx.createGain();
    g.verbSend.gain.value = 0.12;
    g.verb.buffer = springIR(ctx);
    // Reverb taps after the post lane, so it hears the delay and the chorus
    // — reverb last is the order nearly everyone wants.
    g.fxPostOut.connect(g.verbSend).connect(g.verb).connect(g.master);

    g.limiter = ctx.createDynamicsCompressor();
    g.limiter.threshold.value = -2;
    g.limiter.ratio.value = 14;
    g.limiter.attack.value = 0.003;
    g.limiter.release.value = 0.18;
    g.fxPostOut.connect(g.master);
    g.master.connect(g.limiter);
    return g;
  }

  /**
   * Splice a board's pedals into a chain built by buildChain(). Used for the
   * live graph and for the offline render alike.
   *
   * @returns {Map<string, AudioWorkletNode>} uid -> node
   */
  buildPedals(ctx, g, board) {
    const nodes = new Map();
    const lane = (list, inNode, outNode) => {
      inNode.disconnect();
      let prev = inNode;
      for (const p of list) {
        const t = PEDAL_TYPES[p.type];
        if (!t) continue;
        const node = new AudioWorkletNode(ctx, t.processor, {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
          channelCount: 1, channelCountMode: 'explicit',
        });
        // Straight to .value, not a ramp: these are the pedal's starting
        // state, and a freshly built node has nothing to ramp from.
        node.parameters.get('on').value = p.on ? 1 : 0;
        for (const [k, v] of Object.entries(p.values)) {
          const param = node.parameters.get(k);
          if (param) param.value = v;
        }
        prev.connect(node);
        prev = node;
        nodes.set(p.uid, node);
      }
      prev.connect(outNode);
    };
    lane(board.pre, g.fxPreIn, g.preIn);
    lane(board.post, g.fxPostIn, g.fxPostOut);
    return nodes;
  }

  /**
   * Replace the live board. Structural changes — adding, removing,
   * reordering — rebuild the lanes, so the output is dipped for the moment
   * it takes. Knob turns and footswitches never come through here; they go
   * to the existing node's parameters and do not click.
   */
  async setBoard(board) {
    this.board = board;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const dip = this.master.gain;
    const keep = 'master' in this.requested ? this.requested.master : dip.value;
    dip.cancelScheduledValues(t);
    dip.setValueAtTime(dip.value, t);
    dip.linearRampToValueAtTime(0, t + 0.012);
    await new Promise((r) => setTimeout(r, 16));
    for (const node of this.pedalNodes.values()) {
      try { node.port.postMessage({ type: 'stop' }); node.disconnect(); } catch {}
    }
    this.pedalNodes = this.buildPedals(this.ctx, this, board);
    const t2 = this.ctx.currentTime;
    dip.setValueAtTime(0, t2);
    dip.linearRampToValueAtTime(keep, t2 + 0.02);
  }

  /** Turn one pedal's knob. Smoothed, so a CC sweep does not zipper. */
  setPedalValue(id, k, v) {
    const hit = findPedal(this.board, id);
    if (!hit) return;
    hit.pedal.values[k] = v;
    const node = this.pedalNodes.get(id);
    const param = node && node.parameters.get(k);
    if (param) param.setTargetAtTime(v, this.ctx.currentTime, 0.012);
  }

  /** Stomp. Not smoothed here — the pedal crossfades its own bypass. */
  setPedalOn(id, on) {
    const hit = findPedal(this.board, id);
    if (!hit) return;
    hit.pedal.on = !!on;
    const node = this.pedalNodes.get(id);
    if (node) node.parameters.get('on').setValueAtTime(on ? 1 : 0, this.ctx.currentTime);
  }

  async init() {
    if (this.ctx) return;
    // 'interactive' is the whole difference between an amp you can play and a
    // thing that answers you a fifth of a second later.
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule('js/audio/amp-worklet.js');
    await ctx.audioWorklet.addModule('js/audio/pedal-worklet.js');

    Object.assign(this, this.buildChain(ctx));
    this.pedalNodes = this.buildPedals(ctx, this, this.board);
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
    this.di.connect(this.diGain).connect(this.fxPreIn);
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
  async renderStimulus(input, opts = {}) {
    if (!this.ctx) throw new Error('power the amp on first');

    // Render at the STIMULUS's rate, not the live context's.
    //
    // The live context runs at whatever the output device is doing, and that
    // is none of the measurement's business — plug in headphones and it can
    // move from 48 kHz to 44.1 between two renders of the same settings.
    // Decoding a 48 kHz stimulus into a 44.1 kHz context also resamples it
    // on the way in, so the thing being measured is no longer the file.
    const rate = input instanceof ArrayBuffer
      ? (wavSampleRate(input) || this.ctx.sampleRate)
      : input.sampleRate;

    // decodeAudioData resamples to its own context's rate, so decode in a
    // context that is already at the rate we want.
    const src = input instanceof ArrayBuffer
      ? await new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: rate })
        .decodeAudioData(input.slice(0))
      : input;

    // A tail, so the reverb and the last decay are not cut off mid-ring.
    const frames = src.length + Math.round(rate * 2);
    const off = new OfflineAudioContext({ numberOfChannels: 1, length: frames, sampleRate: rate });
    await off.audioWorklet.addModule('js/audio/amp-worklet.js');
    await off.audioWorklet.addModule('js/audio/pedal-worklet.js');

    const g = this.buildChain(off);
    g.limiter.connect(off.destination);
    // The same board, rebuilt here. A board of bypassed pedals passes the
    // signal through bit for bit, so calibration renders are unaffected
    // unless a pedal is actually on — opts.pedals:false leaves it out
    // entirely when that matters.
    if (opts.pedals !== false) this.buildPedals(off, g, this.board);

    // Carry every setting across, preferring what was asked for over what
    // the live AudioParam currently holds — see `requested`.
    for (const [name, param] of this.amp.parameters) {
      const target = g.amp.parameters.get(name);
      if (!target) continue;
      target.value = name in this.requested ? this.requested[name] : param.value;
    }
    const want = (k, node, dflt) =>
      (k in this.requested ? this.requested[k] : (node ? node.gain.value : dflt));
    g.master.gain.value = want('master', this.master);
    g.verbSend.gain.value = want('reverb', this.verbSend);
    const mix = 'cabMix' in this.requested ? this.requested.cabMix : this.cabWet.gain.value;
    g.cabWet.gain.value = mix;
    g.cabDry.gain.value = 1 - mix;

    const { stack, treble, mid, bass } = this.tone;
    g.amp.port.postMessage({ type: 'tone', k: coeffs(stack, treble, mid, bass, rate * 4) });
    // The voicing has to travel too, or a fit would render the stock amp.
    if (Object.keys(this.voicing).length) {
      g.amp.port.postMessage({ type: 'voicing', v: { ...this.voicing } });
    }

    // The cab has to be built for THIS context, not copied from the live one.
    //
    // An AudioBuffer carries its own sample rate, and a ConvolverNode refuses
    // one that disagrees with its context — rightly, since the alternative is
    // an impulse response played at the wrong speed, which is a different
    // speaker. The generated cab is cheap to render again at the right rate;
    // a loaded IR gets decoded again from the bytes it arrived as.
    if (this.irData) {
      g.cab.buffer = await off.decodeAudioData(this.irData.slice(0));
    } else {
      g.cab.buffer = await renderCab(off, this.cabOpts);
    }

    const node = off.createBufferSource();
    node.buffer = copyBuffer(off, src);
    node.connect(g.fxPreIn);
    node.start();

    return off.startRendering();
  }

  async setCab(opts) {
    this.cabOpts = { ...(this.cabOpts || { speaker: 'v30', axis: 0.6, distance: 0.25 }), ...opts };
    // nulls clear an override rather than becoming one
    for (const k of Object.keys(this.cabOpts)) {
      if (this.cabOpts[k] == null) delete this.cabOpts[k];
    }
    this.irData = null;                 // back to the generated cab
    this.cab.buffer = await renderCab(this.ctx, this.cabOpts);
  }

  /** Drop a measured impulse response in over the generated one. */
  async loadIR(file) {
    // Keep the bytes. An offline render at a different sample rate has to
    // decode the IR again rather than reuse a buffer locked to this context's
    // rate, and the original file is the only lossless way back.
    const data = await file.arrayBuffer();
    const buf = await this.ctx.decodeAudioData(data.slice(0));
    this.irData = data;
    this.cab.buffer = buf;
    return buf.duration;
  }

  /** Override part of the preamp's voicing. See VOICING in amp-worklet.js. */
  setVoicing(v) {
    Object.assign(this.voicing, v);
    this.amp.port.postMessage({ type: 'voicing', v: this.voicing });
  }

  /** Back to the shipped voicing. A sweep resets before each setting, so
   *  every entry means "stock except these" and is reproducible on its own
   *  rather than inheriting whatever the previous one happened to set. */
  resetVoicing() {
    this.voicing = {};
    this.amp.port.postMessage({ type: 'voicing', v: null });
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
    this.requested[name] = value;
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
    this.src.connect(this.fxPreIn);
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

/**
 * A short bright reverb: an amp's spring tank, roughly.
 *
 * Seeded noise, not Math.random(). Unseeded, every build of the chain drew
 * a different tank, so two renders of identical settings differed by up to
 * 0.04 — enough to make "do these pedals change anything when they are
 * off?" unanswerable, because the answer was always yes. Same fix, same
 * reason, as the cab's cone noise.
 */
function springIR(ctx) {
  const rate = ctx.sampleRate;
  const len = Math.round(rate * 1.4);
  const buf = ctx.createBuffer(2, len, rate);
  let a = 0x5eed5;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const t = i / rate;
      const env = Math.exp(-t * 4.2);
      // The chirp is what makes a spring sound like a spring.
      d[i] = (rand() * 2 - 1) * env * 0.5
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

/**
 * Sample rate straight out of a WAV header, without decoding it.
 *
 * Needed to decide what rate to decode AT, which is a chicken-and-egg the
 * Web Audio API has no other answer to: decodeAudioData resamples to the
 * context it is called on, so you have to know the rate before you can
 * decode without changing it.
 *
 * @returns {number|null} null if this is not a PCM WAV
 */
function wavSampleRate(ab) {
  const v = new DataView(ab);
  if (v.byteLength < 44) return null;
  const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1),
    v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  // Walk the chunks: anything that has been through an editor carries LIST
  // or bext chunks before fmt.
  let off = 12;
  while (off + 8 <= v.byteLength) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    if (id === 'fmt ') return v.getUint32(off + 12, true);
    off += 8 + size + (size & 1);
  }
  return null;
}
