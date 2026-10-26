// The cabinet panel: pick a speaker by what it is and what it does to the
// sound, and build your own.
//
//   the cards     one per speaker, with the cab's layout drawn (1x10, 1x12,
//                 2x12, 4x12) and a sparkline of its tone; custom cabs after
//   the curve     the cab's frequency response — lows, mids, presence, fizz
//                 — with every stock speaker faint behind it, all at the
//                 current mic position and levelled at 1 kHz, so a change of
//                 speaker or mic shows as a change of shape
//   edit cab      the speaker's own character as dials (body resonance,
//                 thump, low end, presence, top end) and how many of them,
//                 saved under a name as a custom cab
//
// Everything here becomes cab options, the same object engine.setCab takes
// in both builds, so a custom cab sounds identical in the browser and the app.

import { SPEAKERS, SPEAKER_COUNT, CAB_SHAPE, renderCab } from '../audio/cab.js';
import { responseOf } from '../audio/cabfit.js';
import { controls } from '../controls.js';
import { makeKnob } from './knob.js';

const STORE = 'amp.cabs.v1';
const RATE = 48000;
const LO = 60, HI = 10000;
const FREQS = Array.from({ length: 40 }, (_, i) => LO * Math.pow(HI / LO, i / 39));
const K1 = FREQS.reduce((best, f, i) => (Math.abs(f - 1000) < Math.abs(FREQS[best] - 1000) ? i : best), 0);
const SIZE = { g12m: 12, g12t: 12, v30: 12, jensen: 10, blue: 12 };
/** The keys a custom cab may set on top of its speaker. */
const SHAPE_KEYS = ['count', 'res', 'resDb', 'tilt', 'presDb', 'top'];

/** The dials, each a cab option: label, range, how to show it. */
const DIALS = [
  { key: 'res', label: 'Body', min: 70, max: 450, fmt: (v) => `${Math.round(v)} Hz`, title: 'Where the cab’s low-mid body resonance sits' },
  { key: 'resDb', label: 'Thump', min: 0, max: 9, fmt: (v) => `${v.toFixed(1)} dB`, title: 'How strong that resonance is' },
  { key: 'low', label: 'Low end', min: 0, max: 20, fmt: (v) => `${v.toFixed(1)} dB`, title: 'Bass below about 900 Hz' },
  { key: 'presDb', label: 'Presence', min: 0, max: 10, fmt: (v) => `${v.toFixed(1)} dB`, title: 'The cone’s upper-mid bite' },
  { key: 'top', label: 'Top end', min: 1500, max: 6000, fmt: (v) => `${(v / 1000).toFixed(1)} kHz`, title: 'Where the highs roll off' },
];

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (name, attrs) => {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

/**
 * @param {object} o engine; setKnob(key, value) for the amp's axis and
 *   distance knobs; els: { cards, edit, editBtn, canvas, caption }
 */
export function initCabView({ engine, setKnob, els }) {
  const curves = new Map();      // options JSON -> Promise<curve>
  let customs = loadCustoms();
  let editing = false;

  function loadCustoms() {
    if (engine.native) return (engine.saved && engine.saved.cabs) || [];
    try { return JSON.parse(localStorage.getItem(STORE) || '[]'); } catch { return []; }
  }
  function saveCustoms() {
    if (engine.native) engine.send({ type: 'cabs', cabs: customs });
    else try { localStorage.setItem(STORE, JSON.stringify(customs)); } catch {}
  }

  const opts = () => engine.cabOpts || { speaker: 'v30', axis: 0.6, distance: 0.25 };
  /** A speaker table value, overridden or not. */
  const shapeOf = (o, key) => {
    if (typeof o[key] === 'number') return o[key];
    const sp = SPEAKERS[o.speaker] || SPEAKERS.v30;
    return key in sp ? sp[key] : CAB_SHAPE[key];
  };
  const countOf = (o) => (typeof o.count === 'number' ? o.count : SPEAKER_COUNT[o.speaker] || 1);
  const nameOf = (o) => {
    const sp = SPEAKERS[o.speaker] || SPEAKERS.v30;
    return sp.name.replace(/\s*\d+x\d+$/, '');
  };

  /** The tone of a cab, in dB at FREQS, 0 dB at 1 kHz. Cached. */
  function curve(o) {
    const clean = {};
    for (const k of Object.keys(o).sort()) if (k !== 'custom' && o[k] != null) clean[k] = o[k];
    const key = JSON.stringify(clean);
    if (!curves.has(key)) {
      curves.set(key, renderCab(new OfflineAudioContext(1, 1, RATE), clean).then((ir) => {
        const db = responseOf(ir, RATE, FREQS, 3);
        const ref = db[K1];
        return db.map((d) => d - ref);
      }));
    }
    return curves.get(key);
  }

  // ---- cards ----

  /** The cab's front: n speakers of a size, as circles in a box. */
  function layout(count, size) {
    const svg = svgEl('svg', { viewBox: '0 0 48 40', class: 'layout' });
    svg.appendChild(svgEl('rect', { x: 1, y: 1, width: 46, height: 38, rx: 4, class: 'box' }));
    const r = (size / 12) * (count >= 4 ? 8 : count === 2 ? 9.5 : 13);
    const at = count >= 4 ? [[15, 12], [33, 12], [15, 28], [33, 28]]
      : count === 2 ? [[14, 20], [34, 20]] : [[24, 20]];
    for (const [cx, cy] of at) {
      svg.appendChild(svgEl('circle', { cx, cy, r: r.toFixed(1), class: 'cone' }));
      svg.appendChild(svgEl('circle', { cx, cy, r: (r * 0.3).toFixed(1), class: 'dust' }));
    }
    return svg;
  }

  async function spark(o) {
    const c = await curve(o);
    const svg = svgEl('svg', { viewBox: '0 0 100 30', class: 'spark', preserveAspectRatio: 'none' });
    const y = (d) => Math.max(1, Math.min(29, 15 - d * 0.9));
    svg.appendChild(svgEl('path', {
      d: c.map((d, i) => `${i ? 'L' : 'M'}${((i / (c.length - 1)) * 100).toFixed(1)} ${y(d).toFixed(1)}`).join(' '),
    }));
    return svg;
  }

  function selectedId() {
    const o = opts();
    if (o.custom && customs.some((c) => c.id === o.custom)) return `custom:${o.custom}`;
    return SHAPE_KEYS.some((k) => typeof o[k] === 'number') ? 'edited' : `stock:${o.speaker}`;
  }

  function card(id, title, sub, o) {
    const b = document.createElement('button');
    b.className = 'spkcard';
    b.dataset.id = id;
    b.title = sub;
    b.append(layout(countOf(o), SIZE[o.speaker] || 12));
    const t = document.createElement('span');
    t.className = 'spk-name';
    t.textContent = title;
    const s = document.createElement('span');
    s.className = 'spk-sub';
    s.textContent = sub;
    b.append(t, s);
    const a = opts();
    // Sparklines at the current mic position, so the cards compare like
    // for like with the curve below.
    spark({ ...o, axis: a.axis, distance: a.distance }).then((sv) => b.append(sv));
    return b;
  }

  function renderCards() {
    els.cards.innerHTML = '';
    for (const [id, sp] of Object.entries(SPEAKERS)) {
      const n = SPEAKER_COUNT[id];
      els.cards.append(card(`stock:${id}`, sp.name.replace(/\s*\d+x\d+$/, ''),
        `${n}x${SIZE[id]}`, { speaker: id }));
    }
    for (const c of customs) {
      const o = { speaker: c.speaker };
      for (const k of SHAPE_KEYS) if (typeof c[k] === 'number') o[k] = c[k];
      els.cards.append(card(`custom:${c.id}`, c.name,
        `${countOf(o)}x${SIZE[c.speaker] || 12} ${nameOf(o)}`, o));
    }
    markSelected();
  }

  function markSelected() {
    const sel = selectedId();
    for (const b of els.cards.children) b.classList.toggle('on', b.dataset.id === sel);
  }

  els.cards.addEventListener('click', async (e) => {
    const b = e.target.closest('.spkcard');
    if (!b) return;
    const [kind, id] = b.dataset.id.split(':');
    const clear = Object.fromEntries(SHAPE_KEYS.map((k) => [k, null]));
    try {
      if (kind === 'stock') {
        await engine.setCab({ speaker: id, custom: null, ...clear });
      } else {
        const c = customs.find((x) => x.id === id);
        if (!c) return;
        const o = { ...clear, speaker: c.speaker, custom: c.id };
        for (const k of SHAPE_KEYS) if (typeof c[k] === 'number') o[k] = c[k];
        await engine.setCab(o);
        if (typeof c.axis === 'number') setKnob('axis', c.axis);
        if (typeof c.distance === 'number') setKnob('distance', c.distance);
      }
    } catch {
      // The browser engine cannot render a cab before power-on; the choice
      // is still remembered in cabOpts and applied when it powers on.
    }
    const s = document.getElementById('speaker');
    if (s) s.value = opts().speaker;
    refresh();
  });

  // ---- the curve ----

  let drawToken = 0;
  async function drawCurve() {
    const token = ++drawToken;
    const c = els.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 600, h = 150;
    const a = opts();
    const stock = await Promise.all(Object.keys(SPEAKERS).map((id) => curve({ speaker: id, axis: a.axis, distance: a.distance })));
    const mine = await curve(a);
    if (token !== drawToken) return;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    c.style.height = `${h}px`;
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const x = (f) => (Math.log(f / LO) / Math.log(HI / LO)) * w;
    const top = 18, bot = h - 16;
    const y = (d) => top + ((12 - d) / 48) * (bot - top);   // +12 .. -36 dB

    // What each part of the range is, in words.
    const bands = [[LO, 250, 'lows'], [250, 2000, 'mids'], [2000, 5000, 'presence'], [5000, HI, 'fizz']];
    g.font = '9px ui-monospace,monospace';
    g.textAlign = 'center';
    bands.forEach(([f0, f1, label], i) => {
      if (i % 2) { g.fillStyle = 'rgba(255,255,255,.025)'; g.fillRect(x(f0), top, x(f1) - x(f0), bot - top); }
      g.fillStyle = css('--faint');
      g.fillText(label, (x(f0) + x(f1)) / 2, 11);
    });
    g.strokeStyle = 'rgba(255,255,255,.08)';
    g.beginPath(); g.moveTo(0, y(0)); g.lineTo(w, y(0)); g.stroke();
    g.fillStyle = css('--faint');
    g.textAlign = 'left';
    for (const [f, t] of [[100, '100'], [1000, '1k'], [10000, '10k']]) g.fillText(t, Math.min(x(f) + 3, w - 18), h - 4);

    const line = (cv) => {
      g.beginPath();
      cv.forEach((d, i) => { const px = x(FREQS[i]), py = y(d); i ? g.lineTo(px, py) : g.moveTo(px, py); });
    };
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(160,141,121,.35)';
    for (const cv of stock) { line(cv); g.stroke(); }
    line(mine);
    g.lineTo(w, bot); g.lineTo(0, bot); g.closePath();
    g.fillStyle = 'rgba(224,161,82,.12)';
    g.fill();
    line(mine);
    g.lineWidth = 2.2;
    g.strokeStyle = css('--accent');
    g.stroke();
  }

  // ---- edit cab ----

  // Dial values live in the cab options; "low" is the low shelf's gain,
  // which the speaker table holds as its negative, `tilt`.
  const dialGet = (key) => (key === 'low' ? -shapeOf(opts(), 'tilt') : shapeOf(opts(), key));
  let editTimer = null;
  const pending = {};
  const dialSet = (key, v) => {
    if (key === 'low') pending.tilt = -v; else pending[key] = v;
    clearTimeout(editTimer);
    editTimer = setTimeout(async () => {
      const o = { ...pending };
      for (const k of Object.keys(pending)) delete pending[k];
      try { await engine.setCab(o); } catch {}
      refresh();
    }, 120);
  };

  for (const d of DIALS) {
    controls.register({
      id: `cab.${d.key}`, label: d.label, group: 'Cab', min: d.min, max: d.max, fmt: d.fmt,
      get: () => (pending[d.key === 'low' ? 'tilt' : d.key] != null
        ? (d.key === 'low' ? -pending.tilt : pending[d.key]) : dialGet(d.key)),
      set: (v) => dialSet(d.key, v),
    });
  }

  els.edit.innerHTML = `
    <div class="edit-dials"></div>
    <div class="edit-row">
      <div class="seg count" title="How many of this speaker. An approximation: each doubling is a bigger box with more cone, so a lower, stronger body and more low end.">
        <button data-n="1">1×</button><button data-n="2">2×</button><button data-n="4">4×</button>
      </div>
      <input class="cab-name" type="text" maxlength="40" placeholder="Name this cab">
      <button class="mini save">Save</button>
      <button class="mini saveas">Save as new</button>
      <button class="mini del">Delete</button>
    </div>
    <p class="note edit-note">Dials start from the speaker you picked. Axis and Distance are saved with it too.</p>`;
  const dials = els.edit.querySelector('.edit-dials');
  for (const d of DIALS) {
    const k = makeKnob(`cab.${d.key}`, { fmt: d.fmt });
    k.title = d.title;
    dials.append(k);
  }
  const nameIn = els.edit.querySelector('.cab-name');

  els.edit.querySelector('.count').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const n = +b.dataset.n;
    // Back to the speaker's own count clears it, so the stock cab stays
    // bit-for-bit the stock cab.
    try { await engine.setCab({ count: n === (SPEAKER_COUNT[opts().speaker] || 1) ? null : n }); } catch {}
    refresh();
  });

  function snapshot(id, name) {
    const o = opts();
    const c = { id, name, speaker: o.speaker, axis: o.axis, distance: o.distance };
    for (const k of SHAPE_KEYS) if (typeof o[k] === 'number') c[k] = o[k];
    return c;
  }
  async function save(asNew) {
    const o = opts();
    const name = nameIn.value.trim() || `My ${countOf(o)}x${SIZE[o.speaker] || 12} ${nameOf(o)}`;
    let id = !asNew && o.custom && customs.some((c) => c.id === o.custom) ? o.custom : null;
    if (!id) {
      id = Math.random().toString(36).slice(2, 10);
      customs.push(snapshot(id, name));
    } else {
      customs = customs.map((c) => (c.id === id ? snapshot(id, name) : c));
    }
    saveCustoms();
    try { await engine.setCab({ custom: id }); } catch {}
    renderCards();
    refresh();
  }
  els.edit.querySelector('.save').addEventListener('click', () => save(false));
  els.edit.querySelector('.saveas').addEventListener('click', () => save(true));
  els.edit.querySelector('.del').addEventListener('click', async () => {
    const o = opts();
    if (!o.custom) return;
    customs = customs.filter((c) => c.id !== o.custom);
    saveCustoms();
    const clear = Object.fromEntries(SHAPE_KEYS.map((k) => [k, null]));
    try { await engine.setCab({ custom: null, ...clear }); } catch {}
    renderCards();
    refresh();
  });

  els.editBtn.addEventListener('click', () => {
    editing = !editing;
    els.edit.hidden = !editing;
    els.editBtn.classList.toggle('on', editing);
    els.editBtn.textContent = editing ? 'Done editing' : 'Edit cab';
    refresh();
  });

  function refreshEdit() {
    const o = opts();
    for (const d of DIALS) controls.emit('change', `cab.${d.key}`, 'cab');
    const n = countOf(o);
    for (const b of els.edit.querySelectorAll('.count button')) b.classList.toggle('on', +b.dataset.n === n);
    const mine = o.custom && customs.find((c) => c.id === o.custom);
    if (document.activeElement !== nameIn) nameIn.value = mine ? mine.name : '';
    els.edit.querySelector('.del').disabled = !mine;
    els.edit.querySelector('.save').textContent = mine ? 'Save' : 'Save as custom cab';
    els.edit.querySelector('.saveas').hidden = !mine;
  }

  // ---- all of it ----

  function refresh() {
    markSelected();
    if (editing) refreshEdit();
    const o = opts();
    const mine = o.custom && customs.find((c) => c.id === o.custom);
    els.caption.textContent = `${mine ? `${mine.name} — ` : ''}${countOf(o)}x${SIZE[o.speaker] || 12} ${nameOf(o)}`
      + `${selectedId() === 'edited' ? ' (edited, not saved)' : ''}. Bright: this cab at the current mic position. `
      + 'Faint: the stock speakers at the same position. All levelled at 1 kHz.';
    drawCurve();
  }

  renderCards();
  // Sparklines follow the mic, but redrawing every card on every knob
  // movement is wasted work; once it settles is enough.
  let sparkTimer = null;
  controls.on((kind, id) => {
    if (kind !== 'change' || (id !== 'amp.axis' && id !== 'amp.distance')) return;
    clearTimeout(sparkTimer);
    sparkTimer = setTimeout(renderCards, 250);
  });
  return { refresh };
}
