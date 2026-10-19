// One knob, used by the amp and by every pedal.
//
// It reads and writes through the controls registry and repaints when the
// registry says its control changed, whoever changed it — the mouse, a MIDI
// knob, a preset. So a CC moving a pedal's Drive turns the knob on screen
// with no special case anywhere.

import { controls } from '../controls.js';

/**
 * @param {string} id a registered control id
 * @param {object} [o] small: a pedal-sized knob; fmt: value text override
 * @returns {HTMLElement}
 */
export function makeKnob(id, o = {}) {
  const d = controls.get(id);
  const div = document.createElement('div');
  div.className = `knob${o.small ? ' small' : ''}`;
  div.dataset.ctl = id;
  div.innerHTML = `<div class="dial"><i></i><b class="ghost"></b></div>
    <div class="k">${d ? d.label : id}</div><div class="v"></div>`;
  const paint = () => {
    div.querySelector('.dial').style.setProperty('--fill', controls.norm(id).toFixed(4));
    div.querySelector('.v').textContent = o.fmt ? o.fmt(controls.value(id)) : controls.display(id);
  };
  paint();

  let dragging = false, lastY = 0;
  div.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true; lastY = e.clientY;
    div.setPointerCapture(e.pointerId);
  });
  div.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // Fine control on shift, because a guitar amp lives in the last 10%.
    const step = e.shiftKey ? 0.0012 : 0.006;
    controls.setNorm(id, controls.norm(id) + (lastY - e.clientY) * step, 'ui');
    lastY = e.clientY;
  });
  const up = (e) => {
    dragging = false;
    try { div.releasePointerCapture(e.pointerId); } catch {}
  };
  div.addEventListener('pointerup', up);
  div.addEventListener('pointercancel', up);
  div.addEventListener('dblclick', () => {
    const def = controls.get(id);
    if (def && 'def' in def) controls.set(id, def.def, 'ui');
  });
  div.addEventListener('wheel', (e) => {
    e.preventDefault();
    controls.setNorm(id, controls.norm(id) - Math.sign(e.deltaY) * 0.02, 'ui');
  }, { passive: false });

  const off = controls.on((kind, cid) => {
    if (cid !== id) return;
    if (kind === 'change') paint();
    if (kind === 'remove') off();
  });
  return div;
}

/**
 * Show where a MIDI knob is sitting while it has not caught up with the
 * value yet — a ghost needle — so an inert knob reads as "not caught yet"
 * rather than as a dead control. null clears it.
 */
export function showCatching(id, n) {
  for (const el of document.querySelectorAll(`[data-ctl="${CSS.escape(id)}"]`)) {
    el.classList.toggle('catching', n != null);
    if (n != null) el.querySelector('.dial')?.style.setProperty('--ghost', n.toFixed(4));
  }
}
