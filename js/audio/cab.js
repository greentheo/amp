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

/** A stable seed from whatever defines this cab. The room is not the cab,
 *  so it stays out: turning Room up and back down leaves the same speaker. */
function seedOf(spec, speaker) {
  let h = 2166136261;
  const mix = (x) => { h = Math.imul(h ^ x, 16777619) >>> 0; };
  for (let i = 0; i < speaker.length; i++) mix(speaker.charCodeAt(i));
  for (const k of Object.keys(spec).sort()) {
    const v = spec[k];
    if (typeof v !== 'number' || k === 'room') continue;
    mix(Math.round(v * 1000));
  }
  return h;
}

export const SPEAKERS = {
  g12m:   { name: 'Greenback 1x12',    res: 247, resQ: 4.2, pres: 2400, presDb: 3.45, top: 2529, tilt: -11.98 },
  g12t:   { name: 'G12T-75 4x12',      res: 286, resQ: 4.96, pres: 3300, presDb: 4.59, top: 2859, tilt: -10.98 },
  v30:    { name: 'V30 2x12',          res: 260, resQ: 4.58, pres: 3951, presDb: 5.17, top: 2749, tilt: -9.98 },
  jensen: { name: 'Jensen 1x10',       res: 338, resQ: 3.44, pres: 2000, presDb: 2.87, top: 3079, tilt: -8.98 },
  blue:   { name: 'Alnico Blue 1x12',  res: 221, resQ: 3.82, pres: 2800, presDb: 4.02, top: 3298, tilt: -8.98 },
};

/**
 * How many speakers each cab above has. Kept out of SPEAKERS on purpose:
 * every numeric field there goes into the cab's noise seed, so adding one
 * would quietly change every cab. A `count` option asks for a different
 * number of the same speaker; see renderCab.
 */
export const SPEAKER_COUNT = { g12m: 1, g12t: 4, v30: 2, jensen: 1, blue: 1 };

/**
 * The parts of the model that are not in the speaker table. Overridable for
 * the same reason the preamp's voicing is: they have to be fitted against a
 * measured response, and you cannot fit a literal.
 *
 * These values are a FIT, not a derivation, and the names describe each
 * filter's job in the chain rather than a property of a real speaker. `res`
 * at 260 Hz is not a V30's free-air resonance — it is the filter that, with
 * the tilt below it, produces the low-mid body a guitar cab has. Worth
 * saying plainly so nobody reads the table as a datasheet.
 */
export const CAB_SHAPE = {
  hp: 115, hpQ: 1.59,        // the cab's own low rolloff
  resDb: 3.53,               // body resonance height
  presQ: 3.52,               // cone breakup width
  topQ: 0.56,                // resonance of the first lowpass
  top2: 2.5, top2Q: 1.5,     // second lowpass, as a multiple of `top`
  tiltHz: 931,
};

// The room's first reflections — floor, walls, ceiling, back wall — at a
// small room's distances in seconds, and how strongly each comes back. They
// stretch with the room.
const REFLECTIONS = [
  [0.0031, -0.55], [0.0053, 0.48], [0.0079, -0.42], [0.0094, 0.37],
  [0.0127, -0.3], [0.0151, 0.27], [0.0196, -0.22], [0.0233, 0.18],
];

/**
 * The room around the cab, added to the impulse before the cab's filters so
 * it is heard through the speaker like everything else. Room 0 is a mic on
 * the grille in a dead studio, and adds nothing; 1 is a big live room. The
 * first reflections come back at the room's size, then a diffuse tail dies
 * away over `rt60`, darker than the direct sound as air and soft furnishings
 * take the top. Further back with the mic, more of it.
 */
function addRoom(d, rate, room, distance, rt60) {
  const len = d.length;
  const size = 0.5 + room;
  const level = room * (0.5 + distance);
  const r = new Float64Array(len);
  for (const [t, g] of REFLECTIONS) {
    const i = Math.round(t * size * rate);
    if (i < len) r[i] += g * level;
  }
  // The tail: seeded on its own, so the room never changes the speaker.
  const rand = rng(0x400f5);
  const onset = REFLECTIONS[0][0] * size;
  for (let i = 1; i < len; i++) {
    const t = i / rate;
    if (t < onset) continue;
    const swell = Math.min(1, (t - onset) / (0.02 * size));
    r[i] += (rand() * 2 - 1) * 0.16 * level * swell * Math.exp((-6.9 * t) / rt60);
  }
  const k = 1 - Math.exp((-2 * Math.PI * 3500) / rate);
  let lp = 0;
  for (let i = 0; i < len; i++) {
    lp += (r[i] - lp) * k;
    d[i] += lp;
  }
}

/**
 * @param {BaseAudioContext} ctx only for its sample rate
 * @param {object} o speaker id, axis 0..1 (dark to bright), distance 0..1,
 *   room 0..1 (none to a big live room), plus any SPEAKERS field or
 *   CAB_SHAPE field to override
 * @returns {Promise<AudioBuffer>}
 */
export async function renderCab(ctx, opts = {}) {
  const { speaker = 'v30', axis = 0.6, distance = 0.25, room = 0 } = opts;
  // Overrides land on top of the speaker's own values, so a fit can move one
  // number without restating the table.
  const spec = { ...CAB_SHAPE, ...(SPEAKERS[speaker] || SPEAKERS.v30), ...opts };
  const rate = ctx.sampleRate;
  // A room makes the response longer: as long as its tail takes to die.
  const rt60 = 0.2 + 0.8 * room;
  const len = Math.round(rate * (room > 0 ? 0.09 + rt60 : 0.09));
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
  if (room > 0) addRoom(d, rate, room, distance, rt60);

  const node = off.createBufferSource();
  node.buffer = src;

  const hp = off.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = spec.hp;
  hp.Q.value = spec.hpQ;

  // More of the same speaker than this cab has, or fewer: each doubling is a
  // bigger box with more cone in it — the body resonance a little lower and
  // stronger, and more low end. An approximation, labelled as one in the UI;
  // at the cab's own count it changes nothing at all.
  const native = SPEAKER_COUNT[speaker] || 1;
  const step = typeof opts.count === 'number' ? Math.log2(opts.count / native) : 0;

  // Free-air resonance: the bump that makes a 1x12 thump.
  const res = off.createBiquadFilter();
  res.type = 'peaking';
  res.frequency.value = spec.res * Math.pow(2, -0.12 * step);
  res.Q.value = spec.resQ;
  res.gain.value = spec.resDb + step;

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
  tilt.gain.value = -spec.tilt + distance * 3 + 1.5 * step;

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
