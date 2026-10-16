// The speaker cabinet, which is more than half of why an amp sounds like an
// amp. A raw preamp into a flat response is a fizzing mess; nearly all of
// that fizz lives above 5 kHz, and a guitar speaker simply cannot reproduce
// it. The cab is the thing that makes distortion listenable.
//
// Rendered rather than hand-written: a short impulse plus a few panel
// reflections pushed through filters in an OfflineAudioContext, which gives a
// real impulse response with no asset to download. Load a measured .wav over
// the top whenever you want the real thing.

/**
 * Deterministic noise for the cone's messiness.
 *
 * This was Math.random(), which meant the same settings produced a slightly
 * different speaker every time — and that is worse than untidy. It makes the
 * amp unreproducible (two renders of one preset are not the same file), and
 * it quietly broke fitting: the optimiser saw a different IR on every
 * evaluation, so it chased the noise and stopped whenever it got a lucky
 * draw. Its fits came back 1.5 dB better than they measured.
 *
 * mulberry32, seeded from the settings, so a cab is a function of its
 * parameters and nothing else.
 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable seed from whatever defines this cab. */
function seedOf(spec, speaker) {
  let h = 2166136261;
  const mix = (x) => { h = Math.imul(h ^ x, 16777619) >>> 0; };
  for (let i = 0; i < speaker.length; i++) mix(speaker.charCodeAt(i));
  for (const k of Object.keys(spec).sort()) {
    const v = spec[k];
    if (typeof v !== 'number') continue;
    mix(Math.round(v * 1000));
  }
  return h;
}

export const SPEAKERS = {
  g12m:   { name: 'Greenback 1x12',  res: 95,  resQ: 2.2, pres: 2400, presDb: 6,  top: 4600, tilt: -2 },
  g12t:   { name: 'G12T-75 4x12',    res: 110, resQ: 2.6, pres: 3300, presDb: 8,  top: 5200, tilt: -1 },
  v30:    { name: 'V30 2x12',        res: 100, resQ: 2.4, pres: 3800, presDb: 9,  top: 5000, tilt: 0 },
  jensen: { name: 'Jensen 1x10',     res: 130, resQ: 1.8, pres: 2000, presDb: 5,  top: 5600, tilt: 1 },
  blue:   { name: 'Alnico Blue 1x12',res: 85,  resQ: 2.0, pres: 2800, presDb: 7,  top: 6000, tilt: 1 },
};

/** The parts of the model that are not in the speaker table. Overridable
 *  for the same reason the preamp's voicing is: they have to be fitted
 *  against a measured response, and you cannot fit a literal. */
export const CAB_SHAPE = {
  hp: 72, hpQ: 0.7,          // the cab's own low rolloff
  resDb: 5,                  // free-air resonance height
  presQ: 1.3,                // cone breakup width
  topQ: 1.1,                 // resonance of the first lowpass
  top2: 1.5, top2Q: 0.6,     // second lowpass, as a multiple of `top`
  tiltHz: 500,
};

/**
 * @param {BaseAudioContext} ctx only for its sample rate
 * @param {object} o speaker id, axis 0..1 (dark to bright), distance 0..1,
 *   plus any SPEAKERS field or CAB_SHAPE field to override
 * @returns {Promise<AudioBuffer>}
 */
export async function renderCab(ctx, opts = {}) {
  const { speaker = 'v30', axis = 0.6, distance = 0.25 } = opts;
  // Overrides land on top of the speaker's own values, so a fit can move one
  // number without restating the table.
  const spec = { ...CAB_SHAPE, ...(SPEAKERS[speaker] || SPEAKERS.v30), ...opts };
  const rate = ctx.sampleRate;
  const len = Math.round(rate * 0.09);
  const off = new OfflineAudioContext(1, len, rate);

  // The impulse, plus the panel bounces that give a cab its boxiness. Further
  // back from the grille, the room contributes more of them.
  const src = off.createBuffer(1, len, rate);
  const d = src.getChannelData(0);
  d[0] = 1;
  const bounces = [
    [0.0011, -0.42], [0.0023, 0.26], [0.0041, -0.18], [0.0067, 0.12], [0.011, -0.07],
  ];
  for (const [t, g] of bounces) {
    const i = Math.round(t * rate);
    if (i < len) d[i] += g * (0.35 + distance * 1.3);
  }
  // A little decaying noise for the cone's own messiness. Seeded, so the
  // same cab is the same cab.
  const rand = rng(seedOf(spec, speaker));
  for (let i = 1; i < len; i++) {
    d[i] += (rand() * 2 - 1) * 0.06 * Math.exp((-i / rate) * 420);
  }

  const node = off.createBufferSource();
  node.buffer = src;

  const hp = off.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = spec.hp;
  hp.Q.value = spec.hpQ;

  // Free-air resonance: the bump that makes a 1x12 thump.
  const res = off.createBiquadFilter();
  res.type = 'peaking';
  res.frequency.value = spec.res;
  res.Q.value = spec.resQ;
  res.gain.value = spec.resDb;

  // Cone breakup — the upper-mid honk that reads as "guitar speaker".
  const pres = off.createBiquadFilter();
  pres.type = 'peaking';
  pres.frequency.value = spec.pres * (0.75 + axis * 0.5);
  pres.Q.value = spec.presQ;
  pres.gain.value = spec.presDb * (0.45 + axis * 0.9);

  // Off-axis is darker, and the cab's top end falls off a cliff either way.
  const lp = off.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = spec.top * (0.72 + axis * 0.55);
  lp.Q.value = spec.topQ;
  const lp2 = off.createBiquadFilter();
  lp2.type = 'lowpass';
  lp2.frequency.value = spec.top * spec.top2;
  lp2.Q.value = spec.top2Q;

  const tilt = off.createBiquadFilter();
  tilt.type = 'lowshelf';
  tilt.frequency.value = spec.tiltHz;
  tilt.gain.value = -spec.tilt + distance * 3;

  node.connect(hp).connect(res).connect(pres).connect(tilt).connect(lp).connect(lp2)
    .connect(off.destination);
  node.start();

  const rendered = await off.startRendering();
  const buf = ctx.createBuffer(1, len, rate);
  const o = buf.getChannelData(0);
  o.set(rendered.getChannelData(0));

  // Normalise by ENERGY, not by peak. Convolution gain is the sum of the
  // impulse response, not its tallest sample — an IR scaled to peak 1.0 can
  // easily have 30 dB of gain, which is how the output ends up pinned against
  // the limiter the moment the cab is switched in.
  let energy = 0;
  for (let i = 0; i < len; i++) energy += o[i] * o[i];
  const norm = energy > 1e-12 ? 1 / Math.sqrt(energy) : 1;
  for (let i = 0; i < len; i++) o[i] *= norm;
  // Fade the tail so the convolution does not end on a step.
  const fade = Math.round(len * 0.25);
  for (let i = 0; i < fade; i++) o[len - fade + i] *= 1 - i / fade;
  return buf;
}
