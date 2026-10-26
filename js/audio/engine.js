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
import { PitchDetector } from './tuner.js';

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
    // Where the amp plays. '' is the system default.
    this.sinkId = '';
    // How the context is opened. These need a new context to change, which
    // restart() handles without losing anything else.
    //
    //   latencyHint 0 asks Chrome for its smallest buffer. 'interactive' is
    //   NOT that: measured on a MacBook it gave 256 frames and 37.8 ms round
    //   trip, where 0 gave 128 frames and 26.9 ms — the output side's
    //   buffering scales with the graph's, so halving one shortens both.
    //   The cost is less slack, so 'safe' stays one click away.
    //
    //   sampleRate null lets the browser choose, which is the default output
    //   device's rate. If the input runs at another rate Chrome resamples on
    //   the way in, and that costs milliseconds — about 8 measured — so
    //   plugging in matches the context to the input.
    this.opts = { latencyHint: 0, sampleRate: null };
    this.diOn = false;
    this.diShape = 'riff';
  }

  /**
   * Can this browser send Web Audio to a chosen device? Chrome and Edge can,
   * on the context itself. Safari and Firefox cannot — Firefox only on media
   * elements, and routing an amp through one of those would add its own
   * buffering on top of the latency this whole design fights for.
   */
  get canPickOutput() {
    return typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
  }

  /**
   * Choose the output: speakers, headphones, an interface. Takes effect
   * immediately if the amp is running, otherwise when it powers on.
   * @param {string} deviceId '' for the system default
   */
  async setOutput(deviceId) {
    this.sinkId = deviceId || '';
    if (this.ctx && this.canPickOutput) await this.ctx.setSinkId(this.sinkId);
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

    // Zero-latency peak limiter at -1 dBFS — see OutLimiter in
    // amp-worklet.js for why it is not a DynamicsCompressorNode.
    g.limiter = new AudioWorkletNode(ctx, 'out-limiter', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    });
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
    const ctx = new AudioContext({
      latencyHint: this.opts.latencyHint,
      ...(this.opts.sampleRate ? { sampleRate: this.opts.sampleRate } : {}),
    });
    this.ctx = ctx;
    // An output chosen before power-on. If that device has gone since, fall
    // back to the default rather than refusing to start.
    if (this.sinkId && this.canPickOutput) {
      try { await ctx.setSinkId(this.sinkId); } catch { this.sinkId = ''; }
    }
    await ctx.audioWorklet.addModule('js/audio/amp-worklet.js');
    await ctx.audioWorklet.addModule('js/audio/pedal-worklet.js');

    Object.assign(this, this.buildChain(ctx));
    this.pedalNodes = this.buildPedals(ctx, this, this.board);
    this.amp.port.onmessage = (e) => { if (this.onMeter) this.onMeter(e.data); };
    // The last stage is the tuner's mute, so nothing upstream that moves the
    // master — a board swap, the lag test, a restart — can undo it.
    this.out = ctx.createGain();
    this.out.gain.value = this.tunerMuted ? 0 : 1;
    this.limiter.connect(this.out).connect(ctx.destination);

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.out.connect(this.analyser);

    // Nothing is plugged in yet, so give it something to amplify.
    this.di = ctx.createBufferSource();
    this.diGain = ctx.createGain();
    this.diGain.gain.value = 0;
    this.di.buffer = makeDI(ctx, 'riff');
    this.di.loop = true;
    this.di.connect(this.diGain).connect(this.fxPreIn);
    this.di.start();

    // A loaded IR survives a restart: decode it again for the new context
    // rather than falling back to the generated cab.
    if (this.irData) {
      this.cab.buffer = await this.ctx.decodeAudioData(this.irData.slice(0));
    } else {
      await this.setCab({});
    }
    this.setTone(this.tone);
  }

  /** A short bright reverb: an amp's spring tank, roughly. */
  springIR() { return springIR(this.ctx); }

  /**
   * Everything renderStimulus() renders with, as plain data: what each
   * control was asked for (preferring that over what a live AudioParam
   * holds mid-ramp — see `requested`), the tone stack, the voicing, the cab
   * and the board. It is also the file the native build reads
   * (ampcore-render --chain), so the two render the same settings by
   * construction rather than by keeping two lists in step. `cab` is null
   * when a loaded IR file is standing in for the generated cab.
   */
  chainSettings() {
    const want = (k, node) => (k in this.requested ? this.requested[k] : node.gain.value);
    const amp = {};
    for (const [name, param] of this.amp.parameters) {
      amp[name] = name in this.requested ? this.requested[name] : param.value;
    }
    return {
      amp,
      tone: { ...this.tone },
      voicing: JSON.parse(JSON.stringify(this.voicing)),
      cab: this.irData ? null : { ...this.cabOpts },
      cabMix: 'cabMix' in this.requested ? this.requested.cabMix : this.cabWet.gain.value,
      reverb: want('reverb', this.verbSend),
      master: want('master', this.master),
      board: JSON.parse(JSON.stringify(this.board)),
    };
  }

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
    const s = this.chainSettings();
    if (opts.pedals !== false) this.buildPedals(off, g, s.board);

    for (const [name, value] of Object.entries(s.amp)) {
      const target = g.amp.parameters.get(name);
      if (target) target.value = value;
    }
    g.master.gain.value = s.master;
    g.verbSend.gain.value = s.reverb;
    g.cabWet.gain.value = s.cabMix;
    g.cabDry.gain.value = 1 - s.cabMix;

    const { stack, treble, mid, bass } = s.tone;
    g.amp.port.postMessage({ type: 'tone', k: coeffs(stack, treble, mid, bass, rate * 4) });
    // The voicing has to travel too, or a fit would render the stock amp.
    if (Object.keys(s.voicing).length) {
      g.amp.port.postMessage({ type: 'voicing', v: s.voicing });
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
      g.cab.buffer = await renderCab(off, s.cab);
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
    this.diOn = !!on;
    if (shape) this.diShape = shape;
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
    this.inputId = deviceId || null;
    // Every one of these is built to wreck a guitar signal. Echo cancellation
    // in particular treats a sustained note as feedback and ducks it.
    // `latency: 0` asks for the smallest capture buffer; browsers that ignore
    // it lose nothing.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: 1, latency: { ideal: 0 },
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    });
    this.connectInput();
    return this.stream.getAudioTracks()[0].label;
  }

  connectInput() {
    if (this.src) { try { this.src.disconnect(); } catch {} }
    this.src = null;
    if (!this.stream || !this.ctx) return;
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.src.connect(this.fxPreIn);
  }

  /**
   * Measure the real round trip: play chirps out of the output, hear them
   * come back on the input, and time them on the context's own clock.
   *
   * Needs a physical loop — an output cabled to an input, or a speaker a
   * microphone can hear. Everything the browser claims about latency is
   * bypassed: this is the delay a note actually suffers between the input
   * jack and the output, which is the one you feel.
   *
   * The chirp is found by matched filtering rather than by a level
   * threshold, so it is timed to a fraction of a sample even through a
   * speaker in a noisy room, and a weak or missing loop is reported as such
   * instead of producing a confident wrong number.
   *
   * @param {object} [o] testDelay: seconds — for validating the method, feed
   *   the chirps back through an in-graph delay instead of the hardware
   */
  async measureLag(o = {}) {
    if (!this.ctx) throw new Error('Power the amp on first.');
    if (!this.src && o.testDelay == null) throw new Error('Plug in an input first — the test listens on it.');
    const ctx = this.ctx, rate = ctx.sampleRate;
    await ctx.audioWorklet.addModule('js/audio/tap-worklet.js');

    // 12 ms log chirp, 600 Hz to 9 kHz, Hann windowed: short, broadband, and
    // inside what a laptop speaker can actually reproduce.
    const tl = Math.round(0.012 * rate);
    const tpl = new Float32Array(tl);
    const f0 = 600, f1 = 9000, T = tl / rate, k = Math.log(f1 / f0);
    for (let i = 0; i < tl; i++) {
      const t = i / rate;
      tpl[i] = Math.sin(((2 * Math.PI * f0 * T) / k) * (Math.exp((t / T) * k) - 1))
        * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (tl - 1)));
    }

    const chirps = o.chirps || 5;
    const gap = 0.4;                 // wide enough that even Bluetooth's 200 ms cannot alias
    const lead = 0.2;
    const total = lead + chirps * gap + 0.5;
    const sig = ctx.createBuffer(1, Math.round(total * rate), rate);
    const sd = sig.getChannelData(0);
    const offs = [];
    for (let c = 0; c < chirps; c++) {
      const at = Math.round((lead + c * gap) * rate);
      offs.push(at);
      for (let i = 0; i < tl; i++) sd[at + i] = tpl[i] * (o.level || 0.3);
    }

    // The amp has to be silent, or the chirp goes out, comes back in, goes
    // through the amp and out again, and the loop measures itself.
    const keep = 'master' in this.requested ? this.requested.master : this.master.gain.value;
    this.master.gain.setTargetAtTime(0, ctx.currentTime, 0.004);

    const tap = new AudioWorkletNode(ctx, 'tap-recorder', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { frames: Math.round((total + 0.3) * rate) },
    });
    // A worklet only runs while something downstream pulls on it.
    const pull = ctx.createGain();
    pull.gain.value = 0;
    tap.connect(pull).connect(ctx.destination);

    const play = ctx.createBufferSource();
    play.buffer = sig;
    let probe = null;
    if (o.testDelay != null) {
      probe = ctx.createDelay(1);
      probe.delayTime.value = o.testDelay;
      play.connect(probe).connect(tap);
    } else {
      play.connect(ctx.destination);
      this.src.connect(tap);
    }

    const got = new Promise((res) => { tap.port.onmessage = (e) => res(e.data); });
    await new Promise((r) => setTimeout(r, 60));
    tap.port.postMessage({ type: 'arm' });
    const t0 = ctx.currentTime + 0.12;
    play.start(t0);
    let rec;
    try {
      rec = await got;
    } finally {
      try { play.disconnect(); } catch {}
      try { if (probe) probe.disconnect(); else this.src.disconnect(tap); } catch {}
      try { tap.disconnect(); pull.disconnect(); } catch {}
      this.master.gain.setTargetAtTime(keep, ctx.currentTime, 0.03);
    }

    const x = rec.data;
    const t0f = Math.round(t0 * rate);
    let peakAbs = 0;
    for (let i = 0; i < x.length; i++) peakAbs = Math.max(peakAbs, Math.abs(x[i]));

    const corrAt = (j) => {
      let a = 0;
      for (let i = 0; i < tl; i++) a += (x[j + i] || 0) * tpl[i];
      return a;
    };
    /** Strongest correlation in [lo, hi), refined to a fraction of a sample. */
    const findPeak = (lo, hi) => {
      lo = Math.max(0, lo); hi = Math.min(x.length - tl, hi);
      let best = -Infinity, at = -1;
      const mags = [];
      for (let j = lo; j < hi; j++) {
        const v = Math.abs(corrAt(j));
        mags.push(v);
        if (v > best) { best = v; at = j; }
      }
      if (at < 0) return null;
      // Parabolic interpolation on the three points around the peak.
      const a = Math.abs(corrAt(at - 1)), b = best, cN = Math.abs(corrAt(at + 1));
      const den = a - 2 * b + cN;
      const frac = den !== 0 ? 0.5 * (a - cN) / den : 0;
      mags.sort((p, q) => p - q);
      const floor = mags[Math.floor(mags.length * 0.5)] || 1e-12;
      return { at: at + frac, snr: best / Math.max(floor, 1e-12) };
    };

    const delays = [];
    let snrMin = Infinity;
    const first = findPeak(t0f + offs[0] - rec.start, t0f + offs[0] - rec.start + Math.round(0.35 * rate));
    if (!first || first.snr < 8) {
      return { ok: false, reason: 'No chirp came back. Is the loop connected, the volume up, and the right input selected?',
        peak: peakAbs, rate };
    }
    const d0 = first.at + rec.start - (t0f + offs[0]);
    for (let c = 0; c < chirps; c++) {
      const expect = t0f + offs[c] - rec.start + Math.round(d0);
      const p = c === 0 ? first : findPeak(expect - Math.round(0.004 * rate), expect + Math.round(0.004 * rate));
      if (!p) continue;
      snrMin = Math.min(snrMin, p.snr);
      delays.push(((p.at + rec.start - (t0f + offs[c])) / rate) * 1000);
    }
    delays.sort((a, b) => a - b);
    const median = delays[Math.floor(delays.length / 2)];
    return {
      ok: true, rate,
      ms: median,
      spread: delays[delays.length - 1] - delays[0],
      delays, snr: snrMin, clipped: peakAbs > 0.98,
      claimed: this.latency().total,
    };
  }

  /**
   * The amp worklet on its own — no pedals, cab, reverb or limiter — for the
   * null test against the native port, which reaches the same point in its
   * chain. Parameters go straight onto the AudioParams, as every Web Audio
   * parameter is, so they are rounded to 32-bit float exactly as they are in
   * a live render.
   *
   * @param {ArrayBuffer} input the stimulus
   * @param {object} s amp params, plus stack/treble/mid/bass, plus voicing
   */
  async renderAmpOnly(input, s = {}) {
    const rate = wavSampleRate(input) || 48000;
    const src = await new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: rate })
      .decodeAudioData(input.slice(0));
    const off = new OfflineAudioContext({
      numberOfChannels: 1, length: src.length + Math.round(rate * 2), sampleRate: rate,
    });
    await off.audioWorklet.addModule('js/audio/amp-worklet.js');
    const amp = new AudioWorkletNode(off, 'amp-processor', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    });
    const P = { drive: 0.55, bias: 0, presence: 0.3, sag: 0.3, masterVol: 0.5, gate: 0.12, stages: 3, ...s };
    for (const k of ['drive', 'bias', 'presence', 'sag', 'masterVol', 'gate', 'stages']) {
      amp.parameters.get(k).value = P[k];
    }
    if (s.tone !== false) {
      amp.port.postMessage({ type: 'tone',
        k: coeffs(P.stack || 'jcm800', P.treble ?? 0.6, P.mid ?? 0.5, P.bass ?? 0.5, rate * 4) });
    }
    if (s.voicing) amp.port.postMessage({ type: 'voicing', v: s.voicing });
    const node = off.createBufferSource();
    node.buffer = copyBuffer(off, src);
    node.connect(amp).connect(off.destination);
    node.start();
    return off.startRendering();
  }

  /** The input device's own sample rate, if the browser will say. */
  inputRate() {
    const t = this.stream && this.stream.getAudioTracks()[0];
    const r = t && t.getSettings ? t.getSettings().sampleRate : null;
    return typeof r === 'number' && r > 0 ? r : null;
  }

  /**
   * Close the context and open a new one with different options, keeping
   * everything else: every knob, the tone stack, the cab, the voicing, the
   * pedalboard, the input, the output device, the built-in guitar.
   *
   * Needed because a context's buffer size and sample rate are fixed when it
   * is created, and those two are most of the latency.
   */
  async restart(opts = {}) {
    Object.assign(this.opts, opts);
    if (!this.ctx) return;
    const old = this.ctx;
    this.ctx = null;
    try { await old.close(); } catch {}
    await this.init();
    await this.resume();
    for (const [k, v] of Object.entries(this.requested)) this.set(k, v);
    if (Object.keys(this.voicing).length) {
      this.amp.port.postMessage({ type: 'voicing', v: { ...this.voicing } });
    }
    // A fresh capture stream, not the old one reattached. Measured: the same
    // devices gave 34 ms on a context opened from cold and 73 ms after the
    // context had been rebuilt with the old stream reconnected — far more
    // than the buffer change between them could account for. The capture
    // side keeps delivering while the new context is being built, and what
    // piles up in between never drains. Reopening the device starts the
    // input from empty.
    if (this.stream) {
      await new Promise((r) => setTimeout(r, 150));
      try { await this.enableInput(this.inputId); } catch { this.connectInput(); }
    }
    if (this.diOn) this.setDI(true, this.diShape);
  }

  /**
   * Round-trip latency in ms, as honestly as the browser will say: the
   * input's capture latency, the graph's own buffer, and the output device.
   *
   * This used to be read once, at power-on, and reported 5 ms. That was the
   * graph buffer alone: Chrome reports outputLatency as 0 until the device
   * has been running for a moment, and input latency was never counted at
   * all. The real figure on the same machine was nearer 38 ms. Read it
   * repeatedly, and include every part the browser will admit to.
   */
  latency() {
    if (!this.ctx) return null;
    const base = (this.ctx.baseLatency || 0) * 1000;
    const out = (this.ctx.outputLatency || 0) * 1000;
    let input = 0;
    const track = this.stream && this.stream.getAudioTracks()[0];
    if (track && track.getSettings) {
      const l = track.getSettings().latency;
      if (typeof l === 'number' && Number.isFinite(l)) input = l * 1000;
    }
    return { input, base, out, total: input + base + out, measured: out > 0 };
  }

  level() {
    if (!this.analyser) return 0;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
    return peak;
  }

  /**
   * The tuner. While it is on, `onTuner` gets a reading 30 times a second,
   * { hz, clarity, rms }, taken from the input before any pedal; with `mute`
   * the output is silent meanwhile, as a tuner pedal's is. False if there is
   * no audio to listen to yet.
   */
  setTuner(on, mute) {
    clearInterval(this.tunerTimer);
    this.tunerTimer = null;
    this.tunerMuted = !!(on && mute);
    if (!this.ctx) return false;
    this.out.gain.setTargetAtTime(this.tunerMuted ? 0 : 1, this.ctx.currentTime, 0.008);
    if (!on) return true;
    const look = () => {
      // A restart builds a new context; follow it.
      if (!this.tunerTap || this.tunerTap.context !== this.ctx) {
        const det = new PitchDetector(this.ctx.sampleRate);
        const tap = this.ctx.createAnalyser();
        let size = 32;
        while (size < det.window()) size *= 2;
        tap.fftSize = size;
        this.fxPreIn.connect(tap);
        this.tunerTap = tap;
        this.tunerDet = det;
        this.tunerBuf = new Float32Array(size);
      }
      this.tunerTap.getFloatTimeDomainData(this.tunerBuf);
      if (this.onTuner) this.onTuner(this.tunerDet.analyse(this.tunerBuf));
    };
    this.tunerTimer = setInterval(look, 33);
    return true;
  }

  /** Mute for a moment, then come back to `master`. */
  panic(master) {
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
    setTimeout(() => this.master.gain.setTargetAtTime(master, this.ctx.currentTime, 0.05), 400);
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
export function springIR(ctx) {
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
