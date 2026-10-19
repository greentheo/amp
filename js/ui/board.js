// The pedalboard on screen.
//
// Two lanes, before the amp and after the cab, because order and placement
// are half of what a pedalboard is. Each pedal's knobs and its footswitch
// are registered controls, so the MIDI layer can bind to them like anything
// else; a pedal that is removed takes its controls with it.
//
// Reordering is buttons rather than drag and drop. Drag is nicer with a
// mouse and miserable on a phone, and this has to work on an iPad on a
// music stand.

import { controls } from '../controls.js';
import { makeKnob } from './knob.js';
import { PEDAL_TYPES, makePedal, restoreBoard, findPedal } from '../audio/pedals.js';

const STORE = 'amp.board.v1';

export function loadBoard() {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) return restoreBoard(JSON.parse(raw));
  } catch { /* storage off, or an old shape: fall through */ }
  return null;
}

let saveTimer = null;
function saveBoard(board) {
  // Knob drags fire constantly; one write when they stop is plenty.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE, JSON.stringify(board)); } catch {}
  }, 300);
}

/**
 * @param {object} o engine, host element, onStructure(removedUids) — told
 *   when pedals are removed so their MIDI bindings can be dropped
 */
export function initBoard({ engine, host, onStructure = () => {} }) {
  const board = engine.board;

  function registerPedal(p) {
    const t = PEDAL_TYPES[p.type];
    const group = t.name;
    for (const prm of t.params) {
      controls.register({
        id: `pedal.${p.uid}.${prm.k}`, label: prm.label, group, def: prm.def,
        fmt: prm.fmt || null,
        get: () => p.values[prm.k],
        set: (v) => { p.values[prm.k] = v; engine.setPedalValue(p.uid, prm.k, v); saveBoard(board); },
      });
    }
    controls.register({
      id: `pedal.${p.uid}.on`, label: 'On', group, kind: 'switch',
      get: () => p.on,
      set: (v) => { p.on = !!v; engine.setPedalOn(p.uid, p.on); saveBoard(board); },
    });
  }

  for (const lane of ['pre', 'post']) for (const p of board[lane]) registerPedal(p);

  // A footswitch from MIDI has to light the LED and dim the pedal as surely
  // as a click does, so the card listens to the registry rather than to its
  // own button.
  controls.on((kind, id) => {
    if (kind !== 'change' || !id.startsWith('pedal.') || !id.endsWith('.on')) return;
    const uid = id.slice(6, -3);
    const card = host.querySelector(`.pedal[data-uid="${uid}"]`);
    const hit = findPedal(board, uid);
    if (card && hit) card.classList.toggle('off', !hit.pedal.on);
  });

  async function structural(removed = []) {
    await engine.setBoard(board);
    saveBoard(board);
    render();
    if (removed.length) onStructure(removed);
  }

  function card(p, laneName, i, laneLen) {
    const t = PEDAL_TYPES[p.type];
    const el = document.createElement('div');
    el.className = `pedal${p.on ? '' : ' off'}`;
    el.dataset.uid = p.uid;
    el.style.setProperty('--pc', t.colour);
    el.title = t.blurb;

    const head = document.createElement('div');
    head.className = 'ph';
    head.innerHTML = `<span class="pname">${t.name}</span>
      <span class="pctl">
        <button class="pb" data-act="left" title="Move earlier"${i === 0 ? ' disabled' : ''}>&#8249;</button>
        <button class="pb" data-act="right" title="Move later"${i === laneLen - 1 ? ' disabled' : ''}>&#8250;</button>
        <button class="pb" data-act="lane" title="${laneName === 'pre' ? 'Move after the cab' : 'Move before the amp'}">&#8645;</button>
        <button class="pb" data-act="remove" title="Remove">&times;</button>
      </span>`;
    el.appendChild(head);

    const knobs = document.createElement('div');
    knobs.className = 'pknobs';
    for (const prm of t.params) knobs.appendChild(makeKnob(`pedal.${p.uid}.${prm.k}`, { small: true }));
    el.appendChild(knobs);

    const stomp = document.createElement('button');
    stomp.className = 'stomp';
    stomp.dataset.ctl = `pedal.${p.uid}.on`;
    stomp.innerHTML = '<i class="led"></i><span class="sw"></span>';
    stomp.addEventListener('click', () => controls.toggle(`pedal.${p.uid}.on`, 'ui'));
    el.appendChild(stomp);

    head.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const list = board[laneName];
      const at = list.indexOf(p);
      if (b.dataset.act === 'left' && at > 0) {
        [list[at - 1], list[at]] = [list[at], list[at - 1]];
        structural();
      } else if (b.dataset.act === 'right' && at < list.length - 1) {
        [list[at + 1], list[at]] = [list[at], list[at + 1]];
        structural();
      } else if (b.dataset.act === 'lane') {
        list.splice(at, 1);
        board[laneName === 'pre' ? 'post' : 'pre'].push(p);
        structural();
      } else if (b.dataset.act === 'remove') {
        list.splice(at, 1);
        controls.unregister(`pedal.${p.uid}.`);
        structural([p.uid]);
      }
    });
    return el;
  }

  function addButton(laneName) {
    const wrap = document.createElement('div');
    wrap.className = 'padd';
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="">+ Add a pedal</option>'
      + Object.values(PEDAL_TYPES)
        .map((t) => `<option value="${t.id}">${t.name}${t.lane !== laneName ? ' *' : ''}</option>`)
        .join('');
    sel.title = 'Starred pedals usually go on the other side of the amp — they will still work here.';
    sel.addEventListener('change', () => {
      if (!sel.value) return;
      const p = makePedal(sel.value, { on: true });
      board[laneName].push(p);
      registerPedal(p);
      structural();
    });
    wrap.appendChild(sel);
    return wrap;
  }

  function render() {
    host.innerHTML = '';
    for (const [laneName, title] of [['pre', 'Before the amp'], ['post', 'After the cab']]) {
      const lane = document.createElement('div');
      lane.className = 'lane';
      lane.innerHTML = `<div class="lt">${title}</div>`;
      const row = document.createElement('div');
      row.className = 'lrow';
      board[laneName].forEach((p, i) => row.appendChild(card(p, laneName, i, board[laneName].length)));
      row.appendChild(addButton(laneName));
      lane.appendChild(row);
      host.appendChild(lane);
    }
    host.dispatchEvent(new CustomEvent('rendered'));
  }

  render();
  return { render, board };
}
