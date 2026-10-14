// A guitar that is not there.
//
// An amp with no guitar plugged in is a page that does nothing, and the first
// thing anyone wants to know is what it sounds like. So: Karplus-Strong
// plucked strings, rendered into a looping riff. It is obviously synthetic on
// its own, which is fine — its job is to be a realistic *input* to the amp,
// with the transient and the harmonic content of a pickup, not to pass for a
// real player.

const E2 = 82.41;
const SHAPES = {
  riff:  [[0,0,0.9],[0,3,0.7],[0,5,0.8],[0.75,0,0.9],[1.0,3,0.7],[1.25,5,0.8],
          [1.5,7,0.9],[1.75,5,0.6],[2.0,3,0.8],[2.5,0,1.0],[3.0,0,0.7],[3.25,-2,0.8]],
  chug:  [[0,0,1.0],[0.25,0,0.6],[0.5,0,0.9],[0.75,0,0.6],[1.0,0,1.0],[1.25,0,0.6],
          [1.5,3,0.9],[1.75,3,0.6],[2.0,0,1.0],[2.25,0,0.6],[2.5,5,0.9],[2.75,3,0.8]],
  chord: [[0,0,0.8],[0.02,7,0.8],[0.04,12,0.8],[0.06,16,0.7],
          [2.0,-2,0.8],[2.02,5,0.8],[2.04,10,0.8],[2.06,14,0.7]],
};

/** One plucked string, written straight into `out` starting at `at`. */
function pluck(out, rate, at, hz, vel, damp) {
  const n = Math.max(2, Math.round(rate / hz));
  const buf = new Float32Array(n);
  // A pick excites the high end much harder than a mathematical impulse does.
  let last = 0;
  for (let i = 0; i < n; i++) {
    const noise = Math.random() * 2 - 1;
    last = last * 0.4 + noise * 0.6;
    buf[i] = last * (1 - i / n) * vel;
  }
  const start = Math.round(at * rate);
  const dur = Math.min(out.length - start, Math.round(rate * 2.2));
  let idx = 0, prev = 0;
  for (let i = 0; i < dur; i++) {
    const cur = buf[idx];
    const y = (cur + prev) * 0.5 * damp;      // the loop filter is the decay
    buf[idx] = y;
    prev = cur;
    idx = (idx + 1) % n;
    out[start + i] += y;
  }
}

/**
 * @param {BaseAudioContext} ctx
 * @param {string} shape riff | chug | chord
 * @returns {AudioBuffer} mono, loops cleanly
 */
export function makeDI(ctx, shape = 'riff', tempo = 100) {
  const rate = ctx.sampleRate;
  const beat = 60 / tempo;
  const notes = SHAPES[shape] || SHAPES.riff;
  const bars = shape === 'chord' ? 4 : 3.5;
  const len = Math.round(rate * (bars + 0.5) * beat);
  const buf = ctx.createBuffer(1, len, rate);
  const d = buf.getChannelData(0);

  for (const [t, semi, vel] of notes) {
    const hz = E2 * Math.pow(2, semi / 12);
    pluck(d, rate, t * beat, hz, vel, 0.996);
  }

  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak > 1e-6) for (let i = 0; i < len; i++) d[i] *= 0.6 / peak;
  // Wrap the tail into the head so the loop point does not click.
  const wrap = Math.round(rate * 0.4);
  for (let i = 0; i < wrap && len - wrap + i < len; i++) {
    d[i] += d[len - wrap + i] * (1 - i / wrap);
  }
  return buf;
}
