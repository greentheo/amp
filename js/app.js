// Wiring: knobs, the input chain, and the two displays that tell you whether
// the thing is actually working.

import { Engine } from './audio/engine.js';
import { STACKS } from './audio/tonestack.js';
import { SPEAKERS } from './audio/cab.js';
import { encodeWav } from './audio/wav.js';

const $ = (id) => document.getElementById(id);
const engine = new Engine();

/** min, max, default, and how to show it. `curve: 'log'` for anything the ear
 *  hears logarithmically, which is most of it. */
const KNOBS = {
  preamp: [
    { k: 'drive',  label: 'Gain',    min: 0, max: 1, def: 0.35 },
    { k: 'bass',   label: 'Bass',    min: 0, max: 1, def: 0.5, tone: true },
    { k: 'mid',    label: 'Mid',     min: 0, max: 1, def: 0.5, tone: true },
    { k: 'treble', label: 'Treble',  min: 0, max: 1, def: 0.6, tone: true },
    { k: 'bias',   label: 'Bias',    min: -0.5, max: 0.5, def: 0 },
  ],
  power: [
    { k: 'presence',  label: 'Presence', min: 0, max: 1, def: 0.3 },
    { k: 'sag',       label: 'Sag',      min: 0, max: 1, def: 0.3 },
    { k: 'masterVol', label: 'Volume',   min: 0, max: 1, def: 0.5 },
    { k: 'gate',      label: 'Gate',     min: 0, max: 1, def: 0.12 },
    { k: 'reverb',    label: 'Reverb',   min: 0, max: 1, def: 0.12, bus: true },
    { k: 'master',    label: 'Master',   min: 0, max: 1, def: 0.8, bus: true },
  ],
  cabknobs: [
    { k: 'axis',     label: 'Axis',     min: 0, max: 1, def: 0.6, cab: true },
    { k: 'distance', label: 'Distance', min: 0, max: 1, def: 0.25, cab: true },
    { k: 'cabMix',   label: 'Cab',      min: 0, max: 1, def: 1, bus: true },
  ],
};

const values = {};
const KNOB_BY_KEY = {};
let recorder = null, recChunks = [], recStart = 0;

/* ---------------- knobs ---------------- */

function buildKnobs() {
  for (const [host, list] of Object.entries(KNOBS)) {
    const el = $(host);
    for (const spec of list) {
      values[spec.k] = spec.def;
      const div = document.createElement('div');
      div.className = 'knob';
      div.dataset.k = spec.k;
      div.innerHTML = `<div class="dial"><i></i></div>
        <div class="k">${spec.label}</div><div class="v"></div>`;
      el.appendChild(div);
      KNOB_BY_KEY[spec.k] = { spec, div };
      wireKnob(div, spec);
      paint(div, spec);
    }
  }
}

const norm = (s, v) => (v - s.min) / (s.max - s.min);

function paint(div, spec) {
  const t = norm(spec, values[spec.k]);
  div.querySelector('.dial').style.setProperty('--fill', t.toFixed(4));
  const v = values[spec.k];
  div.querySelector('.v').textContent =
    spec.max - spec.min <= 1.001 && spec.min < 0 ? v.toFixed(2) : Math.round(t * 10);
}

function wireKnob(div, spec) {
  let dragging = false, lastY = 0;
  const apply = () => { paint(div, spec); push(spec); };

  div.addEventListener('pointerdown', (e) => {
    dragging = true; lastY = e.clientY;
    div.setPointerCapture(e.pointerId);
  });
  div.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const span = spec.max - spec.min;
    // Fine control on shift, because a guitar amp lives in the last 10%.
    const step = span * (e.shiftKey ? 0.0012 : 0.006);
    values[spec.k] = Math.min(spec.max, Math.max(spec.min, values[spec.k] + (lastY - e.clientY) * step));
    lastY = e.clientY;
    apply();
  });
  const up = (e) => {
    dragging = false;
    try { div.releasePointerCapture(e.pointerId); } catch {}
  };
  div.addEventListener('pointerup', up);
  div.addEventListener('pointercancel', up);
  div.addEventListener('dblclick', () => { values[spec.k] = spec.def; apply(); });
  div.addEventListener('wheel', (e) => {
    e.preventDefault();
    const span = spec.max - spec.min;
    values[spec.k] = Math.min(spec.max, Math.max(spec.min,
      values[spec.k] - Math.sign(e.deltaY) * span * 0.02));
    apply();
  }, { passive: false });
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
    cabTimer = setTimeout(async () => {
      await engine.setCab({ axis: values.axis, distance: values.distance });
      drawCab();
      $('ir-note').textContent = 'generated — no asset to download';
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
  const entry = KNOB_BY_KEY[k];
  if (!entry) throw new Error(`no knob "${k}"`);
  const { spec, div } = entry;
  values[k] = Math.min(spec.max, Math.max(spec.min, v));
  paint(div, spec);
  push(spec);
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
      ? { voicing: { ...engine.voicing } } : {}) };
}

/**
 * Apply a setting object: knob names go to knobs, `stack`/`stages`/`speaker`
 * to their selects. Waits for the cab to re-render if it had to.
 */
async function applySetting(setting) {
  let cab = false;
  for (const [k, v] of Object.entries(setting)) {
    if (k === 'voicing') {
      engine.resetVoicing();
      engine.setVoicing(v);
    } else if (k === 'stack' || k === 'stages' || k === 'speaker') {
      setSelect(k, v);
      if (k === 'speaker') cab = true;
    } else {
      setKnob(k, v);
      if (KNOB_BY_KEY[k].spec.cab) cab = true;
    }
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

/** The cab's impulse response, drawn as the curve it actually is. */
function drawCab() {
  const c = $('cabcurve');
  const { ctx, w, h } = fit(c, 90);
  ctx.clearRect(0, 0, w, h);
  const buf = engine.cab && engine.cab.buffer;
  if (!buf) return;
  const d = buf.getChannelData(0);
  ctx.strokeStyle = css('--accent');
  ctx.lineWidth = 1;
  ctx.beginPath();
  const n = Math.min(d.length, Math.round(buf.sampleRate * 0.03));
  for (let x = 0; x < w; x++) {
    const i = Math.floor((x / w) * n);
    const y = h / 2 - d[i] * h * 0.45;
    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.fillStyle = css('--faint');
  ctx.font = '9px ui-monospace,monospace';
  ctx.fillText(`${(n / buf.sampleRate * 1000).toFixed(0)} ms of impulse response`, 6, 12);
}

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

function frame() {
  try {
    if (engine.ctx) {
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
  $('stack').addEventListener('change', (e) => engine.setTone({ stack: e.target.value }));

  for (const [id, s] of Object.entries(SPEAKERS)) $('speaker').add(new Option(s.name, id));
  $('speaker').value = 'v30';
  $('speaker').addEventListener('change', async (e) => {
    await engine.setCab({ speaker: e.target.value });
    drawCab();
    $('ir-note').textContent = 'generated — no asset to download';
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
    } catch (err) {
      $('in-state').textContent = `no mic: ${err.name}`;
    }
  });
  $('device').addEventListener('change', async (e) => {
    try { $('in-state').textContent = await engine.enableInput(e.target.value); } catch {}
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
  pushAll();
  engine.set('stages', +$('stages').value);
  drawCab();

  const l = engine.latency();
  $('latency').textContent = l
    ? `${l.total.toFixed(1)} ms · ${engine.ctx.sampleRate / 1000} kHz`
    : '—';
  requestAnimationFrame(frame);
}

buildKnobs();
wireSelects();
wireDI();
wireInput();
wireRecorder();
wireCalibration();
$('btn-begin').addEventListener('click', begin, { once: true });
$('btn-panic').addEventListener('click', () => {
  if (!engine.ctx) return;
  engine.master.gain.setTargetAtTime(0, engine.ctx.currentTime, 0.01);
  setTimeout(() => engine.master.gain.setTargetAtTime(values.master, engine.ctx.currentTime, 0.05), 400);
});
addEventListener('resize', () => { drawCab(); });
