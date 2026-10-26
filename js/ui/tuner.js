// The tuner: a strip across the top of the page, opened from the bar.
//
// What it shows is a tuner pedal's: the note, big; a needle over ±50 cents
// that settles in the middle when the string is right, with a light either
// side saying which way to turn the peg; and the frequency, for anyone
// tuning to something odd. The six strings of standard tuning sit underneath
// with the one being played lit, since "which string is this?" is most of
// what a beginner is asking.
//
// It is a control like any other ("tuner.on"), so a footswitch can be
// mapped to it, which is how a tuner pedal is used. While it is on the amp
// is muted, unless that is switched off. The note is found by
// js/audio/tuner.js in the browser and by the same code in C++ in the app.

import { controls } from '../controls.js';
import { TunerTrack, hzOf, noteOf } from '../audio/tuner.js';

const KEY = 'amp.tuner.v1';
// Standard tuning, low to high, as MIDI notes.
const STANDARD = [['E', 40], ['A', 45], ['D', 50], ['G', 55], ['B', 59], ['E', 64]];
// Within this many cents, it is in tune: about a fifth of what a trained
// ear can hear on a sustained note.
const IN_TUNE = 2;

/**
 * @param {object} o engine; host, the element the strip goes in; button,
 *   the bar's toggle
 * @returns {{ refresh(): void }} refresh once the audio is running
 */
export function initTuner({ engine, host, button }) {
  const prefs = { a4: 440, mute: true };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {} };
  const track = new TunerTrack();
  let open = false;

  host.innerHTML = `
    <div class="plate wide tunerplate">
      <div class="badge">TUNER</div>
      <div class="tun">
        <div class="tun-note"><span class="tun-name">–</span><span class="tun-oct"></span></div>
        <div class="tun-meter">
          <div class="tun-lights"><span class="tun-flat" title="Flat: tune up">◀</span><span class="tun-mid"></span><span class="tun-sharp" title="Sharp: tune down">▶</span></div>
          <div class="tun-scale"><div class="tun-zone"></div><div class="tun-needle"></div></div>
          <div class="tun-ticks"><span>−50</span><span>−25</span><span>0</span><span>+25</span><span>+50</span></div>
          <div class="tun-strings"></div>
        </div>
        <div class="tun-side">
          <div class="tun-read"><b class="tun-cents"></b><span class="tun-hz"></span></div>
          <p class="tun-hint"></p>
          <label class="sel tun-ref" title="The pitch of the A above middle C. 440 Hz is the standard.">A4
            <select class="dev mini-sel"></select>
          </label>
          <button class="mini tun-mute" title="Silence the amp while the tuner is open">Mute while tuning</button>
        </div>
      </div>
    </div>`;
  const q = (sel) => host.querySelector(sel);
  const el = {
    plate: q('.tunerplate'), name: q('.tun-name'), oct: q('.tun-oct'), needle: q('.tun-needle'),
    cents: q('.tun-cents'), hz: q('.tun-hz'), hint: q('.tun-hint'), ref: q('.tun-ref select'),
    mute: q('.tun-mute'), strings: q('.tun-strings'),
  };
  for (let hz = 430; hz <= 450; hz++) el.ref.add(new Option(`${hz} Hz`, String(hz)));
  el.ref.value = String(prefs.a4);
  const chips = STANDARD.map(([name, midi]) => {
    const s = document.createElement('span');
    s.textContent = name;
    s.dataset.midi = String(midi);
    el.strings.appendChild(s);
    return s;
  });

  function render(v) {
    if (!v) {
      el.plate.dataset.state = 'idle';
      el.name.textContent = '–';
      el.oct.textContent = '';
      el.needle.style.left = '50%';
      el.cents.textContent = '';
      el.hz.textContent = '';
      el.hint.textContent = engine.ctx ? 'Play one string and let it ring.' : 'Power on to tune.';
      for (const c of chips) c.classList.remove('on');
      return;
    }
    // The note is the tracker's, which holds steady through a wobble; the
    // cents are eased, so the needle glides.
    const cents = v.cents;
    const state = Math.abs(cents) <= IN_TUNE ? 'in' : cents < 0 ? 'flat' : 'sharp';
    el.plate.dataset.state = state;
    const shown = noteOf(hzOf(v.midi, prefs.a4), prefs.a4);
    el.name.textContent = shown.name;
    el.oct.textContent = String(shown.octave);
    el.needle.style.left = `${50 + Math.max(-50, Math.min(50, cents))}%`;
    const r = Math.round(cents);
    el.cents.textContent = r === 0 ? '0¢' : `${r > 0 ? '+' : '−'}${Math.abs(r)}¢`;
    el.hz.textContent = `${v.hz.toFixed(1)} Hz`;
    el.hint.textContent = state === 'in' ? 'In tune.' : state === 'flat' ? 'Flat: tune up.' : 'Sharp: tune down.';
    for (const c of chips) c.classList.toggle('on', +c.dataset.midi === v.midi);
  }

  function start() {
    track.reset();
    render(null);
    engine.setTuner(open, prefs.mute);
  }

  engine.onTuner = (p) => { if (open) render(track.push(p, prefs.a4)); };

  controls.register({
    id: 'tuner.on', label: 'Tuner', kind: 'switch',
    get: () => open,
    set: (v) => {
      open = !!v;
      host.hidden = !open;
      button.classList.toggle('on', open);
      start();
    },
  });
  button.dataset.ctl = 'tuner.on';
  button.addEventListener('click', () => controls.toggle('tuner.on', 'ui'));

  el.ref.addEventListener('change', () => {
    prefs.a4 = +el.ref.value;
    save();
    track.reset();
  });
  const showMute = () => el.mute.classList.toggle('on', prefs.mute);
  showMute();
  el.mute.addEventListener('click', () => {
    prefs.mute = !prefs.mute;
    save();
    showMute();
    if (open) engine.setTuner(true, prefs.mute);
  });
  // The app keeps the mute setting for a footswitch that opens the tuner
  // while the page is asleep.
  if (engine.native) engine.setTuner(false, prefs.mute);
  render(null);

  return { refresh: () => { if (open) start(); else render(null); } };
}
