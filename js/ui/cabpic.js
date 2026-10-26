// Little pictures of what the cabinet knobs do, redrawn as they turn.
//
// Axis and Distance are where the microphone is, and that is easier to see
// than to read: a side view of the speaker, with the mic sliding back as
// Distance goes up (and the room's reflections reaching it), and moving off
// the dust cap toward the cone's edge as Axis goes down. Room raises the
// walls around them: off the back wall too, the more of it there is. Cab is a blend, so
// it is drawn as the signal splitting: through the cab, or straight past it.
//
// They follow the controls registry, so a drag, a MIDI knob and a loaded
// setting all move them.

import { controls } from '../controls.js';

const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs, parent) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

/** Side view: speaker on the left, mic to its right. */
function micPicture() {
  const svg = el('svg', { viewBox: '0 0 230 120', class: 'cabpic', role: 'img' });
  el('title', {}, svg).textContent = 'Where the microphone is';
  // The room: a ceiling for Distance's reflections to come off.
  const ceiling = el('line', { x1: 6, y1: 6, x2: 224, y2: 6, class: 'room' }, svg);
  const wall = el('line', { x1: 224, y1: 6, x2: 224, y2: 108, class: 'room' }, svg);
  const bounce = el('path', { class: 'bounce' }, svg);
  const echo = el('path', { class: 'bounce' }, svg);
  // Speaker in profile: magnet, cone, baffle, dust cap, grille cloth.
  el('rect', { x: 6, y: 47, width: 10, height: 26, rx: 2, class: 'mag' }, svg);
  el('path', { d: 'M16 50 L44 16 L44 104 L16 70 Z', class: 'cone' }, svg);
  el('line', { x1: 46, y1: 10, x2: 46, y2: 110, class: 'baffle' }, svg);
  el('path', { d: 'M44 49 A11 11 0 0 1 44 71', class: 'cap' }, svg);
  el('line', { x1: 50, y1: 12, x2: 50, y2: 108, class: 'cloth' }, svg);
  // Where the mic is aimed, and the mic.
  const aim = el('line', { class: 'aim' }, svg);
  const dot = el('circle', { r: 3.5, class: 'spot' }, svg);
  const mic = el('g', { class: 'mic' }, svg);
  el('rect', { x: 0, y: -6, width: 13, height: 12, rx: 6, class: 'head' }, mic);
  el('rect', { x: 12, y: -4, width: 34, height: 8, rx: 3, class: 'body' }, mic);
  el('line', { x1: 46, y1: 0, x2: 58, y2: 0, class: 'cable' }, mic);
  const label = el('text', { x: 224, y: 116, 'text-anchor': 'end', class: 'cap-text' }, svg);

  const draw = (axis, distance, room = 0) => {
    // Distance: from just off the grille to across the room.
    const x = 58 + distance * 112;
    // Axis: 1 is dead centre on the dust cap (bright), 0 out at the edge of
    // the cone (dark), with the mic angled in toward the centre as it goes.
    const target = 60 - (1 - axis) * 40;
    const y = 60 - (1 - axis) * 34;
    const angle = (Math.atan2(target - y, 50 - x) * 180) / Math.PI + 180;
    mic.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${angle.toFixed(1)})`);
    aim.setAttribute('x1', x.toFixed(1)); aim.setAttribute('y1', y.toFixed(1));
    aim.setAttribute('x2', '50'); aim.setAttribute('y2', target.toFixed(1));
    dot.setAttribute('cx', '47'); dot.setAttribute('cy', target.toFixed(1));
    // The room's reflection reaches the mic more the further back it is.
    const mid = (50 + x) / 2;
    bounce.setAttribute('d', `M50 ${target.toFixed(1)} L${mid.toFixed(1)} 6 L${x.toFixed(1)} ${y.toFixed(1)}`);
    bounce.style.opacity = Math.min(1, 0.1 + distance * 0.8 + room * 0.3).toFixed(2);
    // The back wall: the room's own sound, coming back past the mic.
    echo.setAttribute('d', `M50 ${target.toFixed(1)} L224 ${(30 + (1 - room) * 40).toFixed(1)} L${x.toFixed(1)} ${y.toFixed(1)}`);
    echo.style.opacity = (room * 0.9).toFixed(2);
    wall.style.opacity = (0.15 + room * 0.85).toFixed(2);
    ceiling.style.opacity = (0.4 + room * 0.6).toFixed(2);
    const where = axis > 0.75 ? 'on the cap' : axis > 0.35 ? 'cap edge' : 'off-axis, cone edge';
    const how = distance < 0.3 ? 'close' : distance < 0.7 ? 'a little back' : 'well back';
    const space = room < 0.05 ? '' : room < 0.4 ? ', small room' : room < 0.75 ? ', live room' : ', big room';
    label.textContent = `${how}, ${where}${space}`;
  };
  return { svg, draw };
}

/** The blend: the amp's signal through the cab, or straight past it. */
function blendPicture() {
  const svg = el('svg', { viewBox: '0 0 130 120', class: 'cabpic', role: 'img' });
  el('title', {}, svg).textContent = 'Cab against direct';
  el('circle', { cx: 10, cy: 60, r: 4, class: 'node' }, svg);
  el('circle', { cx: 120, cy: 60, r: 4, class: 'node' }, svg);
  const wet = el('path', { d: 'M14 60 C30 60 34 30 50 30 L80 30 C96 30 100 60 116 60', class: 'path' }, svg);
  const dry = el('path', { d: 'M14 60 C30 60 34 90 50 90 L80 90 C96 90 100 60 116 60', class: 'path' }, svg);
  const spk = el('g', { class: 'spk' }, svg);
  el('rect', { x: 56, y: 22, width: 6, height: 16, rx: 1.5 }, spk);
  el('path', { d: 'M62 24 L72 16 L72 44 L62 36 Z' }, spk);
  el('text', { x: 65, y: 12, 'text-anchor': 'middle', class: 'cap-text' }, svg).textContent = 'CAB';
  el('text', { x: 65, y: 110, 'text-anchor': 'middle', class: 'cap-text' }, svg).textContent = 'DIRECT';
  const pct = el('text', { x: 65, y: 64, 'text-anchor': 'middle', class: 'pct' }, svg);

  const draw = (mix) => {
    wet.style.strokeWidth = (1 + mix * 5).toFixed(2);
    wet.style.opacity = (0.15 + mix * 0.85).toFixed(2);
    dry.style.strokeWidth = (1 + (1 - mix) * 5).toFixed(2);
    dry.style.opacity = (0.15 + (1 - mix) * 0.85).toFixed(2);
    spk.style.opacity = (0.25 + mix * 0.75).toFixed(2);
    pct.textContent = mix >= 0.995 ? 'all cab' : mix <= 0.005 ? 'all direct' : `${Math.round(mix * 100)}% cab`;
  };
  return { svg, draw };
}

/** Build both pictures into `host` and keep them in step with the knobs. */
export function mountCabPictures(host) {
  const mic = micPicture();
  const blend = blendPicture();
  host.append(mic.svg, blend.svg);
  const v = (id, dflt) => (controls.get(id) ? controls.value(id) : dflt);
  const drawMic = () => mic.draw(v('amp.axis', 0.6), v('amp.distance', 0.25), v('amp.room', 0));
  const drawBlend = () => blend.draw(v('amp.cabMix', 1));
  drawMic();
  drawBlend();
  controls.on((kind, id) => {
    if (kind !== 'change') return;
    if (id === 'amp.axis' || id === 'amp.distance' || id === 'amp.room') drawMic();
    else if (id === 'amp.cabMix') drawBlend();
  });
}
