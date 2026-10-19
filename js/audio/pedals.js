// What a pedal IS, as data.
//
// A pedal type is a name, a colour, which side of the amp it normally
// lives on, the processor that runs it, and a list of knobs. Nothing here is
// code that only works for the built-ins. That matters because the plan is
// for pedals to be learned as well as written: record a real pedal at a few
// knob settings, fit a model, and register the result as a new type with
// the knob names its owner gave it. When that lands it is a call to
// registerPedalType() — the board, the UI and the MIDI layer already treat
// every type the same way.
//
// Every knob is 0..1. Each processor maps that to its own real range, so a
// CC, a mouse drag and a saved preset all speak the same unit.

const ms = (v) => `${Math.round(40 * Math.pow(30, v))} ms`;
const hz = (lo, span) => (v) => {
  const f = lo * Math.pow(span, v);
  return f < 10 ? `${f.toFixed(1)} Hz` : `${Math.round(f)} Hz`;
};
const db = (lo, hi) => (v) => {
  const d = lo + (hi - lo) * v;
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)} dB`;
};

export const PEDAL_TYPES = {};

/**
 * @param {object} t id, name, lane ('pre'|'post'), colour, processor,
 *   params [{k, label, def, fmt?}], and optionally `trails` for pedals whose
 *   output outlives their input
 */
export function registerPedalType(t) {
  if (!t.id || !t.processor || !Array.isArray(t.params)) {
    throw new Error('a pedal type needs an id, a processor and a list of params');
  }
  PEDAL_TYPES[t.id] = { lane: 'pre', colour: '#666', blurb: '', ...t };
  return PEDAL_TYPES[t.id];
}

// The starting set: one of each thing a board usually has, in the order a
// board usually has them. Generic on purpose — the interesting ones are the
// ones that get learned from real pedals.

registerPedalType({
  id: 'comp', name: 'Compressor', lane: 'pre', colour: '#3b6ea8', processor: 'pedal-comp',
  blurb: 'Sustain. Lets the pick through, then squashes the tail.',
  params: [
    { k: 'sustain', label: 'Sustain', def: 0.5 },
    { k: 'attack', label: 'Attack', def: 0.45, fmt: (v) => `${(Math.pow(40, v)).toFixed(1)} ms` },
    { k: 'level', label: 'Level', def: 0.5, fmt: db(-12, 12) },
  ],
});

registerPedalType({
  id: 'wah', name: 'Wah', lane: 'pre', colour: '#2b2b2b', processor: 'pedal-wah',
  blurb: 'Put the treadle on an expression pedal.',
  params: [
    { k: 'pedal', label: 'Treadle', def: 0.5, fmt: hz(350, 2300 / 350) },
    { k: 'q', label: 'Q', def: 0.5 },
    { k: 'level', label: 'Level', def: 0.5, fmt: db(-12, 12) },
  ],
});

registerPedalType({
  id: 'boost', name: 'Boost', lane: 'pre', colour: '#c9c9c9', processor: 'pedal-boost',
  blurb: 'Clean gain. More drive into the amp, or a solo level after it.',
  params: [
    { k: 'gain', label: 'Gain', def: 0.4, fmt: db(0, 20) },
    { k: 'tone', label: 'Tilt', def: 0.5, fmt: db(-6, 6) },
  ],
});

registerPedalType({
  id: 'overdrive', name: 'Overdrive', lane: 'pre', colour: '#3f8a4a', processor: 'pedal-overdrive',
  blurb: 'The green one. Mids into the amp, bass left alone.',
  params: [
    { k: 'drive', label: 'Drive', def: 0.4 },
    { k: 'tone', label: 'Tone', def: 0.5 },
    { k: 'level', label: 'Level', def: 0.5, fmt: db(-12, 12) },
  ],
});

registerPedalType({
  id: 'fuzz', name: 'Fuzz', lane: 'pre', colour: '#8a2f2f', processor: 'pedal-fuzz',
  blurb: 'Two clipping stages and a scooped tone stack.',
  params: [
    { k: 'fuzz', label: 'Fuzz', def: 0.6 },
    { k: 'tone', label: 'Tone', def: 0.5 },
    { k: 'level', label: 'Level', def: 0.5, fmt: db(-12, 12) },
  ],
});

registerPedalType({
  id: 'volume', name: 'Volume', lane: 'pre', colour: '#4a4a4a', processor: 'pedal-volume',
  blurb: 'Swells, from an expression pedal.',
  params: [
    { k: 'pedal', label: 'Volume', def: 1 },
  ],
});

registerPedalType({
  id: 'chorus', name: 'Chorus', lane: 'post', colour: '#5aa0b8', processor: 'pedal-chorus',
  blurb: 'Two voices, a quarter cycle apart.',
  params: [
    { k: 'rate', label: 'Rate', def: 0.35, fmt: hz(0.05, 100) },
    { k: 'depth', label: 'Depth', def: 0.5 },
    { k: 'mix', label: 'Mix', def: 0.7 },
  ],
});

registerPedalType({
  id: 'phaser', name: 'Phaser', lane: 'post', colour: '#d07a2a', processor: 'pedal-phaser',
  blurb: 'Six stages, three moving notches.',
  params: [
    { k: 'rate', label: 'Rate', def: 0.35, fmt: hz(0.05, 160) },
    { k: 'depth', label: 'Depth', def: 0.7 },
    { k: 'feedback', label: 'Reso', def: 0.4 },
  ],
});

registerPedalType({
  id: 'tremolo', name: 'Tremolo', lane: 'post', colour: '#7a5aa8', processor: 'pedal-tremolo',
  blurb: 'From a smooth sine to an optical chop.',
  params: [
    { k: 'rate', label: 'Rate', def: 0.5, fmt: hz(0.5, 24) },
    { k: 'depth', label: 'Depth', def: 0.6 },
    { k: 'shape', label: 'Shape', def: 0.3 },
  ],
});

registerPedalType({
  id: 'delay', name: 'Delay', lane: 'post', colour: '#3a7a74', processor: 'pedal-delay', trails: true,
  blurb: 'Tone darkens the repeats, Mod adds tape wobble. Trails when off.',
  params: [
    { k: 'time', label: 'Time', def: 0.5, fmt: ms },
    { k: 'feedback', label: 'Repeats', def: 0.35 },
    { k: 'mix', label: 'Mix', def: 0.35 },
    { k: 'tone', label: 'Tone', def: 0.5, fmt: hz(1000, 12) },
    { k: 'mod', label: 'Mod', def: 0.15 },
  ],
});

/* ---------------- the board ---------------- */

let nextId = 1;
/** A short, stable id. MIDI bindings point at pedals by it, so it has to
 *  survive a reload — which is why the board is persisted, uids included. */
function uid() {
  return `p${Date.now().toString(36)}${(nextId++).toString(36)}`;
}

export function makePedal(typeId, opts = {}) {
  const t = PEDAL_TYPES[typeId];
  if (!t) throw new Error(`no pedal type "${typeId}"`);
  const values = {};
  for (const p of t.params) values[p.k] = p.def;
  return { uid: opts.uid || uid(), type: typeId, on: !!opts.on, values: { ...values, ...(opts.values || {}) } };
}

/** What a new player sees: a few pedals in, all switched off. */
export function defaultBoard() {
  return {
    pre: [makePedal('wah'), makePedal('overdrive')],
    post: [makePedal('chorus'), makePedal('delay')],
  };
}

/**
 * Bring a stored board back, dropping anything whose type no longer exists
 * and filling in knobs that were added since it was saved. A stored board
 * from an older version should load, not throw.
 */
export function restoreBoard(data) {
  const lane = (list) => (Array.isArray(list) ? list : [])
    .filter((p) => p && PEDAL_TYPES[p.type])
    .map((p) => makePedal(p.type, { uid: p.uid, on: p.on, values: p.values }));
  if (!data || typeof data !== 'object') return defaultBoard();
  return { pre: lane(data.pre), post: lane(data.post) };
}

export function findPedal(board, id) {
  for (const laneName of ['pre', 'post']) {
    const i = board[laneName].findIndex((p) => p.uid === id);
    if (i >= 0) return { lane: laneName, index: i, pedal: board[laneName][i] };
  }
  return null;
}
