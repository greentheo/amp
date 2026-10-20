// A recorder that knows exactly when it started.
//
// The lag test plays a chirp out at a known frame on the context's clock and
// listens for it coming back in. The only way to turn "where in my recording
// did the chirp land" into milliseconds is to know which frame of the
// context's timeline the recording's first sample belongs to — and
// `currentFrame` inside a worklet is that, exactly, with no main-thread
// jitter between asking and answering.

class Tap extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.frames = (opts.processorOptions && opts.processorOptions.frames) || sampleRate;
    this.buf = null;
    this.w = 0;
    this.start = -1;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'arm') {
        this.buf = new Float32Array(this.frames);
        this.w = 0;
        this.start = -1;
      }
    };
  }

  process(inputs) {
    if (!this.buf) return true;
    const x = inputs[0] && inputs[0][0];
    // An input with nothing connected still has to advance the clock, or a
    // silent loop would record a buffer whose start frame is a lie.
    const n = 128;
    if (this.start < 0) this.start = currentFrame;
    const k = Math.min(n, this.frames - this.w);
    if (x) this.buf.set(x.subarray(0, k), this.w);
    this.w += k;
    if (this.w >= this.frames) {
      const data = this.buf;
      this.buf = null;
      this.port.postMessage({ start: this.start, rate: sampleRate, data }, [data.buffer]);
    }
    return true;
  }
}

registerProcessor('tap-recorder', Tap);
