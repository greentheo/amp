// Wiring: knobs, the input chain, and the two displays that tell you whether
// the thing is actually working.

import { Engine } from './audio/engine.js';
import { NativeEngine, isNative, forwardConsole } from './audio/native.js';
import { STACKS } from './audio/tonestack.js';
import { SPEAKERS } from './audio/cab.js';
import { encodeWav, encodeWavFloat } from './audio/wav.js';
import { fitCab, responseOf, scoreAgainst } from './audio/cabfit.js';
import { controls } from './controls.js';
import { makeKnob, showCatching } from './ui/knob.js';
import { initBoard, loadBoard } from './ui/board.js';
import { setVoice } from './ui/amplook.js';
import { mountCabPictures } from './ui/cabpic.js';
import { initCabView } from './ui/cabview.js';
import { initTuner } from './ui/tuner.js';
import { Midi, sourceText } from './midi.js';
import { NativeMidi } from './native-midi.js';

const $ = (id) => document.getElementById(id);
// Inside the native app the same page drives the app's engine instead of
// Web Audio; see js/audio/native.js.
const engine = isNative() ? new NativeEngine() : new Engine();
if (engine.native) {
  document.documentElement.classList.add('native');
  forwardConsole(engine);
}

/** min, max, default, and how to show it. `curve: 'log'` for anything the ear
 *  hears logarithmically, which is most of it. */
const KNOBS = {
  preamp: [
    // 0.35 used to sit past a cranked JCM800; on the recalibrated knob the
    // same territory is around 0.55.
    { k: 'drive',  label: 'Gain',    min: 0, max: 1, def: 0.55 },
    { k: 'bass',   label: 'Bass',    min: 0, max: 1, def: 0.5, tone: true },
    { k: 'mid',    label: 'Mid',     min: 0, max: 1, def: 0.5, tone: true },
    { k: 'treble', label: 'Treble',  min: 0, max: 1, def: 0.6, tone: true },
    { k: 'bias',   label: 'Bias',    min: -0.5, max: 0.5, def: 0 },
  ],
  power: [
    { k: 'presence',  label: 'Presence', min: 0, max: 1, def: 0.3 },
    { k: 'sag',       label: 'Sag',      min: 0, max: 1, def: 0.3 },
    { k: 'masterVol', label: 'Volume',   min: 0, max: 1, def: 0.5 },
    { k: 'gate',      label: 'Gate',     min: 0, max: 1, def: 0 },
    { k: 'reverb',    label: 'Reverb',   min: 0, max: 1, def: 0.12, bus: true },
    { k: 'master',    label: 'Master',   min: 0, max: 1, def: 0.8, bus: true },
  ],
  cabknobs: [
    { k: 'axis',     label: 'Axis',     min: 0, max: 1, def: 0.6, cab: true },
    { k: 'distance', label: 'Distance', min: 0, max: 1, def: 0.25, cab: true },
    { k: 'room',     label: 'Room',     min: 0, max: 1, def: 0, cab: true },
    { k: 'cabMix',   label: 'Cab',      min: 0, max: 1, def: 1, bus: true },
  ],
};

const values = {};
const KNOB_BY_KEY = {};
let recorder = null, recChunks = [], recStart = 0;

/* ---------------- knobs ---------------- */

// Each amp knob is a control in the registry, and the knob on screen is
// just a view of it. Setting the control is what moves the sound, which is
// why a MIDI knob, a drag and the automation surface cannot disagree.
const GROUP = { preamp: 'Preamp', power: 'Power', cabknobs: 'Cabinet' };

function buildKnobs() {
  for (const [host, list] of Object.entries(KNOBS)) {
    const el = $(host);
    for (const spec of list) {
      values[spec.k] = spec.def;
      controls.register({
        id: `amp.${spec.k}`, label: spec.label, group: GROUP[host],
        min: spec.min, max: spec.max, def: spec.def,
        // Bias is centred on zero and wants its sign; everything else reads
        // 0..10 like the front of an amp.
        fmt: spec.min < 0 ? (v) => v.toFixed(2) : null,
        get: () => values[spec.k],
        set: (v) => { values[spec.k] = v; push(spec); },
      });
      const div = makeKnob(`amp.${spec.k}`);
      div.dataset.k = spec.k;
      el.appendChild(div);
      KNOB_BY_KEY[spec.k] = { spec, div };
    }
  }

  // The stage count is a channel switch, so it is worth a footswitch or a
  // knob too. Stepped: 1 to 4.
  controls.register({
    id: 'amp.stages', label: 'Stages', group: 'Preamp', kind: 'step',
    min: 1, max: 4, step: 1, def: 3,
    fmt: (v) => ['', 'clean', 'crunch', 'lead', 'modern'][v],
    get: () => +$('stages').value,
    set: (v) => {
      $('stages').value = String(v);
      if (engine.ctx) engine.set('stages', v);
    },
  });
  $('stages').addEventListener('change', (e) => controls.emit('change', 'amp.stages', 'ui'));
}

let cabTimer = null;

function push(spec) {
  if (!engine.ctx) return;
  if (spec.tone) {
    engine.setTone({ bass: values.bass, mid: values.mid, treble: values.treble });
  } else if (spec.cab) {
    // Re-rendering an impulse response on every pixel of knob movement is a
    // lot of work to throw away; land on the value instead.
    clearTimeout(cabTimer);
    // A move the app made itself (a MIDI knob) only redraws here; sending
    // it back would count as the page touching the knob.
    const silent = engine.native && engine.quiet;
    cabTimer = setTimeout(async () => {
      const send = () => engine.setCab({ axis: values.axis, distance: values.distance, room: values.room });
      await (silent ? engine.quietly(send) : send());
      drawCab();
      $('ir-note').textContent = '';
    }, 120);
  } else {
    engine.set(spec.k, values[spec.k]);
  }
}

function pushAll() {
  for (const list of Object.values(KNOBS)) {
    for (const spec of list) if (!spec.cab) push(spec);
  }
}

/* ---------------- automation ---------------- */

// A deliberate surface for driving the amp from outside — the calibration
// loop sets a hundred combinations of knobs and renders each one, and doing
// that through synthetic pointer events on knob divs would be absurd.
//
// It is the same path the UI uses: setKnob goes through push() exactly as a
// drag does, so an automated render cannot diverge from what you would get
// by turning the knob yourself. That property is the whole point; a
// calibration against a code path nobody listens to is worth nothing.

function setKnob(k, v) {
  if (!KNOB_BY_KEY[k]) throw new Error(`no knob "${k}"`);
  controls.set(`amp.${k}`, v, 'automation');
  return values[k];
}

function setSelect(id, v) {
  const el = $(id);
  if (!el) throw new Error(`no control "${id}"`);
  el.value = String(v);
  el.dispatchEvent(new Event('change'));
  return el.value;
}

/** Everything that defines the sound right now, as a plain object. */
function snapshot() {
  return { ...values, stack: $('stack').value, stages: +$('stages').value,
    speaker: $('speaker').value,
    // A COPY. engine.voicing is mutated in place by setVoicing, so handing
    // the live object to every row of a sweep manifest makes all of them
    // read back as whatever the last one set.
    ...(Object.keys(engine.voicing || {}).length
      ? { voicing: { ...engine.voicing } } : {}),
    cab: { ...engine.cabOpts } };
}

/**
 * Apply a setting object: knob names go to knobs, `stack`/`stages`/`speaker`
 * to their selects. Waits for the cab to re-render if it had to.
 */
async function applySetting(setting) {
  let cab = false;
  let cabOverride = null;
  for (const [k, v] of Object.entries(setting)) {
    if (k === 'voicing') {
      engine.resetVoicing();
      engine.setVoicing(v);
    } else if (k === 'cab') {
      // Cab shape overrides (see CAB_SHAPE) go to the engine, not to a knob.
      // Axis, Distance and Cab are knobs; resonance, breakup and the rolloff
      // are not, because they are the speaker rather than the mic.
      cabOverride = v;
      cab = true;
    } else if (k === 'stack' || k === 'stages' || k === 'speaker') {
      setSelect(k, v);
      if (k === 'speaker') cab = true;
    } else {
      setKnob(k, v);
      if (KNOB_BY_KEY[k].spec.cab) cab = true;
    }
  }
  if (cabOverride) {
    await engine.setCab(cabOverride);
    drawCab();
  }
  // push() debounces cab re-rendering by 120 ms, and a render that starts
  // before it lands would use the previous impulse response.
  if (cab) await new Promise((r) => setTimeout(r, 260));
  return snapshot();
}

window.amp = {
  get engine() { return engine; },
  snapshot,
  set: applySetting,
  knobs: () => Object.keys(KNOB_BY_KEY),

  /** Render the current settings and save them. Returns the saved path. */
  async render(name) {
    const src = await amp._stimulus();
    const out = await engine.renderStimulus(src);
    const blob = new Blob([encodeWav(out)], { type: 'audio/wav' });
    const file = `${(name || 'amp').replace(/[^A-Za-z0-9._-]/g, '-')}.wav`;
    const res = await fetch(`calibration/${file}`, { method: 'PUT', body: blob });
    if (!res.ok) throw new Error(`save failed: ${res.status}`);
    return res.text();
  },

  /**
   * Render a list of settings in one go. One call instead of one round trip
   * per combination, which is the difference between a sweep that takes a
   * minute and one that takes twenty.
   */
  async sweep(list, prefix = 'sweep') {
    const done = [];
    for (let i = 0; i < list.length; i++) {
      await applySetting(list[i]);
      const path = await amp.render(`${prefix}-${String(i).padStart(3, '0')}`);
      done.push({ i, path, setting: snapshot() });
      $('render-note').textContent = `sweep ${i + 1} of ${list.length}`;
    }
    // A manifest beside the renders, so a filename can be turned back into
    // the settings that produced it. Without it the ranking can tell you
    // which file won and not what it was, which is the only part you wanted.
    await fetch('calibration/sweep.json', {
      method: 'PUT',
      body: new Blob([JSON.stringify(done, null, 2)], { type: 'application/json' }),
    }).catch(() => {});
    $('render-note').textContent = `sweep done — ${done.length} renders`;
    return done;
  },

  /** Fit the cab to a target curve from tools/cabcurve.mjs. */
  async fitCab(targetUrl, opts = {}) {
    const target = await (await fetch(targetUrl)).json();
    const t0 = performance.now();
    const r = await fitCab(engine.ctx, target, opts);
    r.seconds = +((performance.now() - t0) / 1000).toFixed(1);
    return r;
  },

  /** The current cab's response, for checking a fit without a full render. */
  async cabResponse(target) {
    const ir = await import('./audio/cab.js').then((m) => m.renderCab(engine.ctx, engine.cabOpts));
    const resp = responseOf(ir, engine.ctx.sampleRate, target.freq);
    const k = target.freq.indexOf(1000);
    return { db: resp.map((v) => +(v - resp[k]).toFixed(2)),
      err: +scoreAgainst(resp, target.freq, target.db).toFixed(3) };
  },

  /**
   * A reference render of the amp alone, saved as 32-bit float, for
   * tools/native-null.mjs to compare against the native port.
   */
  async renderReference(name, settings = {}) {
    const out = await engine.renderAmpOnly(await amp._stimulus(), settings);
    const blob = new Blob([encodeWavFloat(out)], { type: 'audio/wav' });
    const file = `${name.replace(/[^A-Za-z0-9._-]/g, '-')}.wav`;
    const res = await fetch(`calibration/${file}`, { method: 'PUT', body: blob });
    if (!res.ok) throw new Error(`save failed: ${res.status}`);
    return res.text();
  },

  /**
   * The full chain — pedals, amp, cab, reverb, limiter — rendered through
   * the stimulus the way renderStimulus() does it, saved with the settings
   * it was rendered from, for ampcore-render --chain to null against.
   */
  async renderChain(name) {
    if (engine.irData) throw new Error('a loaded IR file has no native equivalent yet: use the generated cab');
    const file = name.replace(/[^A-Za-z0-9._-]/g, '-');
    const settings = engine.chainSettings();
    const out = await engine.renderStimulus(await amp._stimulus());
    const parts = [
      ['wav', new Blob([encodeWavFloat(out)], { type: 'audio/wav' })],
      ['json', JSON.stringify(settings, null, 2)],
    ];
    for (const [ext, body] of parts) {
      const res = await fetch(`calibration/${file}.${ext}`, { method: 'PUT', body });
      if (!res.ok) throw new Error(`save failed: ${res.status}`);
    }
    return `${file}.wav and ${file}.json`;
  },

  /**
   * The browser half of a chain test again, from the settings already saved
   * beside it: for when the browser's sound has changed on purpose and the
   * reference has to follow. The live panel is not touched.
   */
  async rerenderChain(name) {
    const file = name.replace(/[^A-Za-z0-9._-]/g, '-');
    const res = await fetch(`calibration/${file}.json`);
    if (!res.ok) throw new Error(`no calibration/${file}.json`);
    const out = await engine.renderStimulus(await amp._stimulus(), { settings: await res.json() });
    const put = await fetch(`calibration/${file}.wav`, { method: 'PUT', body: new Blob([encodeWavFloat(out)], { type: 'audio/wav' }) });
    if (!put.ok) throw new Error(`save failed: ${put.status}`);
    return `${file}.wav`;
  },

  _cached: null,
  async _stimulus() {
    if (!amp._cached) {
      const res = await fetch('calibration/stimulus.wav');
      if (!res.ok) throw new Error('no calibration/stimulus.wav — run tools/stimulus.mjs');
      amp._cached = await res.arrayBuffer();
    }
    return amp._cached.slice(0);
  },
};

/* ---------------- pedals and MIDI ---------------- */

let midi = null;
let mapping = false;

function wireBoard() {
  // A saved board comes back with its pedal uids intact, which is what keeps
  // MIDI bindings to pedals pointing at the right pedal after a reload.
  // In the app the board is the app's, already fetched by connect().
  const saved = engine.native ? null : loadBoard();
  if (saved) engine.board = saved;
  const host = $('pedalboard');
  initBoard({
    engine, host,
    onStructure: (removed) => {
      let n = 0;
      for (const uid of removed) n += midi ? midi.dropPrefix(`pedal.${uid}.`) : 0;
      if (n) $('learn-status').textContent = `Removed ${n} binding${n > 1 ? 's' : ''} that pointed at the pedal you deleted.`;
    },
  });
  host.addEventListener('rendered', refreshBadges);
}

/** Mark every bindable control with what drives it. */
function refreshBadges() {
  if (!midi) return;
  for (const el of document.querySelectorAll('[data-ctl]')) {
    const id = el.dataset.ctl;
    const bs = midi.bindingsFor(id);
    let mb = el.querySelector(':scope > .mb');
    if (!mb) { mb = document.createElement('span'); mb.className = 'mb'; el.appendChild(mb); }
    mb.textContent = bs.map(sourceText).join(' · ');
    el.classList.toggle('bound', bs.length > 0);
    el.classList.toggle('armed', mapping && midi.armed === id);
  }
}

function setMapping(on) {
  mapping = on;
  document.body.classList.toggle('mapping', on);
  $('btn-map').classList.toggle('on', on);
  $('btn-map').textContent = on ? 'Done mapping' : 'Map controls';
  if (!on && midi) midi.disarm();
  if (on) {
    $('learn-status').textContent = midi && midi.connected
      ? 'Map mode: click a knob or footswitch, then move the hardware control.'
      : 'Map mode is on, but no MIDI input is connected yet — press Connect MIDI first.';
  }
  refreshBadges();
}

function renderMaps() {
  const t = $('maps');
  if (!midi || !midi.bindings.length) {
    t.innerHTML = '<tr><td class="empty">Nothing mapped yet.</td></tr>';
    return;
  }
  t.innerHTML = `<tr><th>Control</th><th>Source</th><th>Device</th><th>Mode</th>
    <th>Range</th><th title="Soft takeover: a knob waits until it reaches the current value before it drives it">Catch</th><th></th></tr>`;
  for (const b of midi.bindings) {
    const c = controls.get(b.id);
    const tr = document.createElement('tr');
    const isSwitch = c && c.kind === 'switch';
    const modes = isSwitch
      ? [['toggle', 'toggle per press'], ['follow', 'follow switch']]
      : [['absolute', 'absolute'], ['relative', 'relative encoder']];
    tr.innerHTML = `<td>${c ? controls.label(b.id) : `<i>${b.id} (missing)</i>`}</td>
      <td class="src">${sourceText(b)} <span class="stat">ch${b.ch + 1}</span></td>
      <td class="dev" title="${b.device || 'any device'}">${b.device || 'any'}</td>
      <td><select>${modes.map(([v, l]) => `<option value="${v}"${b.mode === v ? ' selected' : ''}>${l}</option>`).join('')}</select></td>
      <td>${isSwitch ? '' : `<input type="number" min="0" max="100" step="1" value="${Math.round(b.lo * 100)}">
        <input type="number" min="0" max="100" step="1" value="${Math.round(b.hi * 100)}">`}</td>
      <td>${isSwitch || b.mode === 'relative' ? '' : `<input type="checkbox"${b.takeover ? ' checked' : ''}>`}</td>
      <td><button class="x" title="Unbind">&times;</button></td>`;
    tr.querySelector('select').addEventListener('change', (e) => { b.mode = e.target.value; midi.save(); renderMaps(); });
    const nums = tr.querySelectorAll('input[type=number]');
    if (nums.length) {
      nums[0].addEventListener('change', (e) => { b.lo = Math.min(1, Math.max(0, +e.target.value / 100)); midi.save(); });
      nums[1].addEventListener('change', (e) => { b.hi = Math.min(1, Math.max(0, +e.target.value / 100)); midi.save(); });
    }
    const cb = tr.querySelector('input[type=checkbox]');
    if (cb) cb.addEventListener('change', (e) => { b.takeover = e.target.checked; midi.save(); });
    tr.querySelector('.x').addEventListener('click', () => midi.remove(b));
    t.appendChild(tr);
  }
}

function wireMidi() {
  let monTimer = null, dotTimer = null;
  // In the app the map lives in the app (see js/native-midi.js); the panel is
  // the same either way.
  midi = new (engine.native ? NativeMidi.bind(null, engine) : Midi)(controls, {
    onStatus: (names) => {
      const live = names.length > 0;
      $('midi-status').textContent = live ? `${names.length} input${names.length > 1 ? 's' : ''} — ${names.join(', ')}` : 'MIDI is on, but no inputs were found';
      $('midi-status').classList.toggle('live', live);
      $('btn-midi').textContent = engine.native ? 'Rescan' : (live ? 'Reconnect' : 'Retry');
      $('midi-dot').classList.toggle('live', live);
    },
    // The decisive diagnostic. If this stays blank while you move a knob,
    // nothing is reaching the page and no amount of mapping will help.
    onActivity: (text, count, device) => {
      const el = $('mon-last');
      el.textContent = device ? `${device} — ${text}` : text;
      el.classList.add('live');
      $('mon-count').textContent = count;
      clearTimeout(monTimer);
      monTimer = setTimeout(() => el.classList.remove('live'), 400);
      $('midi-dot').classList.add('blink');
      clearTimeout(dotTimer);
      dotTimer = setTimeout(() => $('midi-dot').classList.remove('blink'), 90);
    },
    onLearn: (id, msg) => {
      if (msg) $('learn-status').textContent = msg;
      else if (id) $('learn-status').textContent = `Armed: ${controls.label(id)} — move a knob, fader or expression pedal, or press a footswitch.`;
      refreshBadges();
    },
    onBindings: () => { renderMaps(); refreshBadges(); },
    onCatching: (id, n) => showCatching(id, n),
    onNote: (text) => { $('learn-status').textContent = text; },
  });

  $('btn-midi').addEventListener('click', async () => {
    try {
      await midi.enable();
    } catch (err) {
      $('midi-status').textContent = err.message;
    }
  });
  $('btn-midi-jump').addEventListener('click', () => $('midi-panel').scrollIntoView({ behavior: 'smooth' }));
  $('btn-map').addEventListener('click', () => setMapping(!mapping));

  // Map mode takes over clicks on bindable controls before the controls see
  // them, so clicking a knob arms it instead of starting a drag and clicking
  // a footswitch arms it instead of stomping it.
  document.addEventListener('pointerdown', (e) => {
    if (!mapping) return;
    const el = e.target.closest('[data-ctl]');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    if (midi.armed === el.dataset.ctl) midi.disarm(); else midi.arm(el.dataset.ctl);
  }, true);
  document.addEventListener('click', (e) => {
    if (mapping && e.target.closest('[data-ctl]')) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  document.addEventListener('contextmenu', (e) => {
    if (!mapping) return;
    const el = e.target.closest('[data-ctl]');
    if (!el) return;
    e.preventDefault();
    midi.unbindControl(el.dataset.ctl);
    $('learn-status').textContent = `Unbound ${controls.label(el.dataset.ctl)}.`;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mapping) setMapping(false);
  });

  $('btn-midi-export').addEventListener('click', () => {
    if (engine.native) return engine.send({ type: 'midiExport' });
    const blob = new Blob([midi.toPreset()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `amp-midi-${stamp()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
  $('btn-midi-import').addEventListener('click', () => (engine.native ? engine.send({ type: 'midiImport' }) : $('midi-file').click()));
  $('midi-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const n = midi.fromPreset(await f.text());
      $('learn-status').textContent = `Loaded ${n} binding${n === 1 ? '' : 's'}.`;
    } catch (err) {
      $('learn-status').textContent = `Could not load that map: ${err.message}`;
    }
  });
  $('btn-midi-clear').addEventListener('click', () => {
    midi.clear();
    $('learn-status').textContent = 'All bindings cleared.';
  });

  // If MIDI was granted in an earlier session, reconnect without a button.
  // Otherwise the saved map is displayed while nothing is listening, which
  // looks exactly like a working setup that has broken.
  midi.autoEnable().catch(() => {});
  if (!midi.available) {
    $('midi-status').textContent = engine.native
      ? 'MIDI in the app comes next, through CoreMIDI'
      : 'this browser has no Web MIDI (Chrome and Edge do; Safari does not yet)';
    $('btn-midi').disabled = true;
  }
  renderMaps();
  refreshBadges();
  window.amp.midi = midi;
}

/* ---------------- output ---------------- */

// Where the amp plays: speakers, headphones, an interface. Remembered by
// device id and by name, because Chrome hands out new ids when site data is
// cleared, and "the Scarlett" should still mean the Scarlett afterwards.
const OUT_STORE = 'amp.output.v1';
let outLabel = 'System default';

function savedOutput() {
  try { return JSON.parse(localStorage.getItem(OUT_STORE)) || null; } catch { return null; }
}

function outNote(text) {
  const el = $('out-state');
  el.textContent = text || '';
  el.classList.toggle('live', !!text);
}

/** Fill the picker. Returns true if real device names were available. */
async function listOutputs() {
  const sel = $('out-device');
  if (!engine.canPickOutput) {
    sel.disabled = true;
    sel.title = 'This browser cannot send Web Audio to a chosen device. Chrome and Edge can; Safari and Firefox play through the system default.';
    return false;
  }
  let devs = [];
  try {
    devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
  } catch { /* no mediaDevices: leave the default */ }
  // 'default' and 'communications' are aliases Chrome adds for whatever the
  // OS has chosen; '' already means that, so they would only be duplicates.
  const real = devs.filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const named = real.some((d) => d.label);
  sel.innerHTML = '';
  sel.add(new Option('System default', ''));
  if (named) {
    for (const d of real) sel.add(new Option(d.label, d.deviceId));
  } else {
    // Until the page has had audio permission once, Chrome hides device
    // names and most of the devices. Plugging in grants it.
    const o = new Option('Plug in once to list outputs', '');
    o.disabled = true;
    sel.add(o);
  }
  const want = engine.sinkId;
  sel.value = [...sel.options].some((o) => o.value === want) ? want : '';
  return named;
}

/** Put back the output chosen last time, if it is still plugged in. */
async function restoreOutput() {
  const named = await listOutputs();
  const saved = savedOutput();
  if (!saved || !saved.deviceId) return;
  const sel = $('out-device');
  const opts = [...sel.options];
  const hit = opts.find((o) => o.value === saved.deviceId)
    || opts.find((o) => o.value && o.textContent === saved.label);
  if (hit) {
    sel.value = hit.value;
    outLabel = hit.textContent;
    if (engine.sinkId !== hit.value) await engine.setOutput(hit.value).catch(() => {});
  } else if (!named && !engine.ctx) {
    // Names hidden, so it cannot be checked yet. Try it at power-on; the
    // engine falls back to the default if the device has gone.
    engine.sinkId = saved.deviceId;
  } else if (named) {
    outNote(`${saved.label} is not connected — using the system default`);
  }
}

function updateLatency() {
  const l = engine.latency();
  const el = $('latency');
  if (!l) { el.textContent = '—'; return; }
  const inRate = engine.inputRate();
  const mismatch = inRate && inRate !== engine.ctx.sampleRate;
  const g = glitches();
  // Until the output has reported its own latency the total is a floor, not
  // a measurement, and it should look like one.
  el.textContent = `${l.measured ? '' : '≥ '}${l.total.toFixed(1)} ms · ${engine.ctx.sampleRate / 1000} kHz`
    + `${mismatch ? ' ⚠' : ''}${g ? ` · ${g} glitch${g === 1 ? '' : 'es'}` : ''}`;
  el.classList.toggle('warnlat', !!(mismatch || g));
  el.title = `round trip: input ${l.input.toFixed(1)} + processing ${l.base.toFixed(1)} + output ${l.out.toFixed(1)} ms`
    + `\nbuffer: ${Math.round(l.base / 1000 * engine.ctx.sampleRate)} frames`
    + (l.measured ? '' : '\n(the output has not reported its latency yet)')
    + (l.input ? '' : '\n(input latency not reported by this browser, or no input plugged in)')
    + (mismatch ? `\n⚠ input runs at ${inRate / 1000} kHz, the amp at ${engine.ctx.sampleRate / 1000} kHz — Re-plug to match` : '')
    + (g == null ? '\nglitch count: not reported by this browser' : `\nglitches since opening: ${g}`)
    + (engine.native
      ? '\nThis is what the device driver claims. The cable loop has always measured more.'
      : '\nThis is what the browser claims. Measure lag tests it for real.');
}

function wireOutput() {
  const sel = $('out-device');
  sel.addEventListener('change', async () => {
    const id = sel.value;
    const label = id ? sel.selectedOptions[0].textContent : 'System default';
    try {
      await engine.setOutput(id);
      outLabel = label;
      try { localStorage.setItem(OUT_STORE, JSON.stringify({ deviceId: id, label })); } catch {}
      outNote('');
      // A different device has a different output latency, and the number
      // in the header is only worth having if it is the real one.
      if (engine.ctx) setTimeout(updateLatency, 300);
    } catch (err) {
      sel.value = engine.sinkId;
      outNote(`could not switch to ${label}: ${err.name}`);
    }
  });

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', async () => {
      const was = engine.sinkId;
      const wasLabel = outLabel;
      await listOutputs();
      // The output we were playing through has been unplugged. Say so and
      // move to the default, rather than leaving the amp playing into a
      // device that is not there.
      if (was && ![...$('out-device').options].some((o) => o.value === was)) {
        await engine.setOutput('').catch(() => {});
        $('out-device').value = '';
        outLabel = 'System default';
        outNote(`${wasLabel} was unplugged — now on the system default`);
        if (engine.ctx) setTimeout(updateLatency, 300);
      }
    });
  }
  restoreOutput();
}

/* ---------------- latency ---------------- */

// Buffer size and sample rate are fixed when a context is opened, and they
// are most of the lag, so changing either rebuilds the context. The engine
// keeps every setting across that.
const LAT_STORE = 'amp.latency.v1';

function savedLatency() {
  try { return JSON.parse(localStorage.getItem(LAT_STORE)) || {}; } catch { return {}; }
}
function saveLatency() {
  try {
    localStorage.setItem(LAT_STORE, JSON.stringify({
      latencyHint: engine.opts.latencyHint, sampleRate: engine.opts.sampleRate,
    }));
  } catch {}
}

function wireLatency() {
  const s = savedLatency();
  if ('latencyHint' in s) engine.opts.latencyHint = s.latencyHint;
  if (s.sampleRate) engine.opts.sampleRate = s.sampleRate;
  $('buffer-mode').value = String(engine.opts.latencyHint);

  $('buffer-mode').addEventListener('change', async (e) => {
    const v = e.target.value === 'interactive' ? 'interactive' : 0;
    engine.opts.latencyHint = v;
    saveLatency();
    if (engine.ctx) {
      $('latency').textContent = 'reopening…';
      await engine.restart({ latencyHint: v });
      drawCab();
      glitchBase = null;
      setTimeout(updateLatency, 700);
    }
  });
}

/**
 * Run the amp at the input device's own sample rate. If they differ, Chrome
 * resamples everything coming in, and a resampler is a buffer. Called after
 * plugging in, when the device's rate is finally known.
 */
async function matchInputRate() {
  const r = engine.inputRate();
  if (!r || !engine.ctx || engine.ctx.sampleRate === r) return false;
  $('latency').textContent = `matching ${r / 1000} kHz…`;
  await engine.restart({ sampleRate: r });
  saveLatency();
  drawCab();
  glitchBase = null;
  setTimeout(updateLatency, 700);
  return true;
}

// Glitches, where the browser says. Chrome's playoutStats counts the frames
// it had to fill in because the amp was not ready in time — which is what a
// crackle is — so the small buffer can be judged by a number instead of by
// ear. Where it is missing there is no honest substitute, so nothing is
// shown rather than a guess.
let glitchBase = null;
function glitches() {
  const st = engine.ctx && engine.ctx.playoutStats;
  if (!st || typeof st.fallbackFramesEvents !== 'number') return null;
  if (glitchBase == null) glitchBase = st.fallbackFramesEvents;
  return st.fallbackFramesEvents - glitchBase;
}

function wireLagTest() {
  const dlg = $('lagdlg');
  const res = $('lag-result');
  $('btn-lagtest').addEventListener('click', () => { dlg.classList.remove('hidden'); });
  $('btn-lag-close').addEventListener('click', () => dlg.classList.add('hidden'));
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.classList.add('hidden'); });

  $('btn-lag-run').addEventListener('click', async () => {
    const btn = $('btn-lag-run');
    btn.disabled = true;
    res.className = 'lagres';
    res.textContent = 'Listening…';
    try {
      const r = await engine.measureLag();
      if (!r.ok) {
        res.classList.add('bad');
        res.textContent = r.reason + (r.peak < 0.002 ? ' Nothing at all reached the input.' : '');
        return;
      }
      const verdict = r.ms <= 10 ? 'Tight — that plays like an amp.'
        : r.ms <= 15 ? 'Playable. You may feel it on fast picking.'
          : r.ms <= 25 ? 'You will feel this. Try Buffer: smallest, and the same device for In and Out.'
            : 'Too slow to play comfortably. Check for Bluetooth, and try the interface for both In and Out.';
      res.innerHTML = `<div class="lagbig">${r.ms.toFixed(1)} ms</div>
        <div>measured round trip · ${r.rate / 1000} kHz · spread ${r.spread.toFixed(2)} ms across ${r.delays.length} chirps</div>
        <div>the browser claims ${r.claimed.toFixed(1)} ms${Math.abs(r.ms - r.claimed) > 2
          ? ` — <b>${r.ms > r.claimed ? 'it is under-reporting' : 'it is over-reporting'} by ${Math.abs(r.ms - r.claimed).toFixed(1)} ms</b>` : ', which is about right'}</div>
        <div class="lagverdict">${verdict}</div>
        ${r.clipped ? '<div class="bad">The returning chirp clipped the input — turn the level down and run it again for a cleaner number.</div>' : ''}
        ${r.spread > 1 ? '<div class="bad">The chirps disagree by more than a millisecond. Through a speaker that is echoes; through a cable it is jitter, usually from In and Out being two separate devices whose clocks drift against each other.</div>' : ''}`;
      try {
        const log = JSON.parse(localStorage.getItem('amp.lagtests') || '[]');
        log.push({ at: Date.now(), ms: +r.ms.toFixed(2), claimed: +r.claimed.toFixed(2), rate: r.rate,
          buffer: engine.opts.latencyHint, in: $('in-state').textContent, out: $('out-device').selectedOptions[0]?.textContent });
        localStorage.setItem('amp.lagtests', JSON.stringify(log.slice(-50)));
      } catch {}
    } catch (err) {
      res.classList.add('bad');
      res.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

/* ---------------- displays ---------------- */

function fit(c, h) {
  const dpr = devicePixelRatio || 1;
  const w = c.clientWidth;
  if (c.width !== Math.floor(w * dpr) || c.height !== Math.floor(h * dpr)) {
    c.width = Math.floor(w * dpr); c.height = Math.floor(h * dpr);
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/** The cabinet panel's cards and tone curve; see js/ui/cabview.js. */
let cabView = null;
function drawCab() { if (cabView) cabView.refresh(); }

/** Output spectrum, log frequency, with the 5 kHz line marked. */
function drawScope() {
  const c = $('scope');
  const { ctx, w, h } = fit(c, 130);
  ctx.clearRect(0, 0, w, h);
  if (!engine.analyser) return;
  const bins = new Float32Array(engine.analyser.frequencyBinCount);
  engine.analyser.getFloatFrequencyData(bins);
  const rate = engine.ctx.sampleRate;
  const lo = 50, hi = 12000;
  const xOf = (f) => (Math.log(f / lo) / Math.log(hi / lo)) * w;

  ctx.strokeStyle = '#30261e';
  ctx.lineWidth = 1;
  ctx.fillStyle = css('--faint');
  ctx.font = '9px ui-monospace,monospace';
  for (const f of [100, 250, 500, 1000, 2500, 5000, 10000]) {
    const x = xOf(f);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h - 12); ctx.stroke();
    ctx.fillText(f >= 1000 ? `${f / 1000}k` : f, x + 3, h - 3);
  }

  ctx.strokeStyle = css('--accent');
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let started = false;
  for (let x = 0; x < w; x++) {
    const f = lo * Math.pow(hi / lo, x / w);
    const bin = Math.round((f / (rate / 2)) * bins.length);
    const db = bins[Math.min(bins.length - 1, bin)];
    const y = h - 14 - ((db + 100) / 100) * (h - 20);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

let latTick = 0;

function frame() {
  try {
    if (engine.ctx) {
      if ((latTick++ % 60) === 0) updateLatency();
      $('meter-fill').style.width = `${Math.min(100, engine.level() * 100)}%`;
      drawScope();
      if (recorder && recorder.recording) {
        const t = engine.ctx.currentTime - recStart;
        $('rec-time').textContent = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
      }
    }
  } catch (err) { console.error('frame', err); }
  requestAnimationFrame(frame);
}

/* ---------------- wiring ---------------- */

function wireSelects() {
  for (const [id, s] of Object.entries(STACKS)) $('stack').add(new Option(s.name, id));
  $('stack').value = 'jcm800';
  $('stack').addEventListener('change', (e) => { setVoice(e.target.value); engine.setTone({ stack: e.target.value }); });
  setVoice($('stack').value);

  for (const [id, s] of Object.entries(SPEAKERS)) $('speaker').add(new Option(s.name, id));
  $('speaker').value = 'v30';
  $('speaker').addEventListener('change', async (e) => {
    await engine.setCab({ speaker: e.target.value });
    drawCab();
    $('ir-note').textContent = '';
  });

  $('stages').addEventListener('change', (e) => engine.set('stages', +e.target.value));

  $('btn-ir').addEventListener('click', () => $('ir-file').click());
  $('ir-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const secs = await engine.loadIR(f);
      $('ir-note').textContent = `${f.name} — ${(secs * 1000).toFixed(0)} ms`;
      drawCab();
    } catch (err) {
      $('ir-note').textContent = `could not decode ${f.name}`;
    }
    e.target.value = '';
  });
}

function wireDI() {
  let on = false;
  $('btn-di').addEventListener('click', () => {
    on = !on;
    engine.setDI(on);
    $('btn-di').classList.toggle('on', on);
    $('btn-di').textContent = on ? 'Stop the built-in guitar' : 'Play the built-in guitar';
  });
  $('di-shape').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    for (const x of $('di-shape').children) x.classList.toggle('on', x === b);
    engine.setDI(on, b.dataset.shape);
  });
}

async function wireInput() {
  $('btn-input').addEventListener('click', async () => {
    try {
      const label = await engine.enableInput($('device').value || undefined);
      $('in-state').textContent = label || 'input live';
      $('in-state').classList.add('live');
      $('btn-input').textContent = 'Re-plug';
      const devices = (await navigator.mediaDevices.enumerateDevices())
        .filter((d) => d.kind === 'audioinput');
      const sel = $('device');
      sel.innerHTML = '';
      for (const d of devices) sel.add(new Option(d.label || 'input', d.deviceId));
      sel.value = devices.find((d) => d.label === label)?.deviceId || sel.value;
      sel.hidden = devices.length < 2;
      // Permission granted, so output names are visible now too.
      await restoreOutput();
      await matchInputRate();
    } catch (err) {
      $('in-state').textContent = `no mic: ${err.name}`;
    }
  });
  $('device').addEventListener('change', async (e) => {
    try {
      $('in-state').textContent = await engine.enableInput(e.target.value);
      await matchInputRate();
    } catch {}
  });
}

/** Records the master output to a WAV, same approach as the ambient tool. */
function wireRecorder() {
  $('btn-rec').addEventListener('click', async () => {
    if (!engine.ctx) return;
    if (!recorder) recorder = { recording: false };
    if (!recorder.recording) {
      recChunks = [];
      recorder.recording = true;
      recStart = engine.ctx.currentTime;
      recorder.dest = engine.ctx.createMediaStreamDestination();
      engine.limiter.connect(recorder.dest);
      recorder.mr = new MediaRecorder(recorder.dest.stream);
      recorder.mr.ondataavailable = (e) => recChunks.push(e.data);
      recorder.mr.start();
      $('btn-rec').classList.add('on');
      $('rec-label').textContent = 'Stop';
    } else {
      recorder.recording = false;
      $('btn-rec').classList.remove('on');
      $('rec-label').textContent = 'Record';
      await new Promise((r) => { recorder.mr.onstop = r; recorder.mr.stop(); });
      engine.limiter.disconnect(recorder.dest);
      const blob = new Blob(recChunks, { type: recorder.mr.mimeType });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `amp-${stamp()}.webm`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      $('rec-time').textContent = '0:00';
    }
  });
}

/** Render the stimulus through the amp and hand back a WAV. */
function wireCalibration() {
  let stimulus = null;                 // an ArrayBuffer, once chosen

  const run = async (source, label) => {
    if (!engine.ctx) { $('render-note').textContent = 'power the amp on first'; return; }
    const btn = $('btn-render');
    btn.disabled = true;
    $('render-note').textContent = `rendering ${label}\u2026`;
    try {
      const t0 = performance.now();
      const out = await engine.renderStimulus(source);
      const blob = new Blob([encodeWav(out)], { type: 'audio/wav' });
      const name = `amp-${$('stack').value}-${stamp()}.wav`;
      const secs = out.length / out.sampleRate;
      const took = `${secs.toFixed(1)} s in ${((performance.now() - t0) / 1000).toFixed(1)} s`;

      // The dev server takes a PUT and drops the file straight into
      // calibration/, next to whatever it is about to be compared against.
      // The published site is static, so that fails there and the file comes
      // down the ordinary way instead.
      let saved = null;
      try {
        const res = await fetch(`calibration/${name}`, { method: 'PUT', body: blob });
        if (res.ok) saved = await res.text();
      } catch { /* static host; fall through to a download */ }

      if (saved) {
        $('render-note').textContent = `saved ${saved} \u2014 ${took}`;
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        $('render-note').textContent = `${name} \u2014 ${took}`;
      }
    } catch (err) {
      $('render-note').textContent = `render failed: ${err.message}`;
      console.error(err);
    } finally {
      btn.disabled = false;
    }
  };

  $('btn-render').addEventListener('click', async () => {
    if (stimulus) return run(stimulus, 'the loaded file');
    try {
      const res = await fetch('calibration/stimulus.wav');
      if (!res.ok) throw new Error(`${res.status} \u2014 run tools/stimulus.mjs first`);
      stimulus = await res.arrayBuffer();
    } catch (err) {
      $('render-note').textContent = `no stimulus: ${err.message}`;
      return;
    }
    return run(stimulus, 'calibration/stimulus.wav');
  });

  $('btn-stim-file').addEventListener('click', () => $('stim-file').click());
  $('stim-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    stimulus = await f.arrayBuffer();
    $('render-note').textContent = f.name;
    e.target.value = '';
  });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function begin() {
  $('gate').classList.add('hidden');
  await engine.init();
  await engine.resume();
  // The app holds its own settings and the panel was set from them; pushing
  // the panel back would only ever risk overwriting them.
  if (!engine.native) {
    pushAll();
    engine.set('stages', +$('stages').value);
  }
  drawCab();

  // If the remembered output had gone by power-on, the engine fell back to
  // the default; show that rather than a picker that claims otherwise.
  if ($('out-device').value !== engine.sinkId) {
    $('out-device').value = engine.sinkId;
    if (!engine.sinkId && savedOutput()?.deviceId) outNote('saved output not available — using the system default');
  }
  updateLatency();
  tuner.refresh();
  requestAnimationFrame(frame);
}

/** The app's settings onto the panel, without sending any of them back. */
function applyNative(s) {
  if (!s) return;
  engine.quietly(() => {
    const knob = { ...s.amp, ...s.tone, ...(s.cab || {}), cabMix: s.cabMix, reverb: s.reverb, master: s.master };
    for (const k of Object.keys(KNOB_BY_KEY)) if (typeof knob[k] === 'number') setKnob(k, knob[k]);
    if (s.tone?.stack) setSelect('stack', s.tone.stack);
    if (s.amp?.stages) setSelect('stages', s.amp.stages);
    if (s.cab?.speaker) setSelect('speaker', s.cab.speaker);
  });
}

function showAudio(a) {
  $('audio-state').textContent = a && a.rate
    ? `${a.input || 'no input'} \u2192 ${a.output || 'no output'} \u00b7 ${a.buffer} frames`
    : 'no audio device';
  updateLatency();
}

// In the app there is nothing to unlock: the audio is already running, so
// there is no power-on gate, and the browser's device, recording and
// calibration controls give way to the app's own audio settings.
const nativeState = engine.native ? engine.connect() : null;
buildKnobs();
mountCabPictures($('cabpics'));
wireBoard();
wireSelects();
cabView = initCabView({
  engine,
  setKnob,
  els: { cards: $('spkcards'), edit: $('cabedit'), editBtn: $('btn-cabedit'), canvas: $('cabcurve'), caption: $('cabcaption') },
});
if (!engine.native) {
  wireDI();
  wireLatency();
  wireLagTest();
  wireInput();
  wireOutput();
  wireRecorder();
  wireCalibration();
}
wireMidi();
const tuner = initTuner({ engine, host: $('tuner'), button: $('btn-tuner') });
$('btn-panic').addEventListener('click', () => engine.panic(values.master));
if (engine.native) {
  applyNative(nativeState);
  $('btn-audio').addEventListener('click', () => engine.showAudioSettings());
  engine.onAudio = showAudio;
  engine.onState = applyNative;
  await begin();
  showAudio(engine.audio);
} else {
  $('btn-begin').addEventListener('click', begin, { once: true });
}
addEventListener('resize', () => { drawCab(); });
