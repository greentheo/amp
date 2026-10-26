// The amp's look follows the tone stack it is running.
//
// Each stack gets the colours and finish of the kind of amp it comes from —
// tweed, blackface, a gold panel on black, copper, chrome — and a nameplate
// of our own. The real makers' logos stay off it: they are trademarks, and an
// amp sim wearing them reads as endorsed by people who never endorsed it.
// Naming the circuit a stack is taken from ("after the Marshall JCM800") is
// just saying what it is, and that line stays.
//
// The page stays a digital instrument: this only sets colours and type
// through CSS variables on .app[data-voice]; nothing becomes a photo of a
// knob. See css/style.css, "the amp's looks".

import { STACKS } from '../audio/tonestack.js';

/** Stack id -> the look's id and its nameplate. */
export const VOICES = {
  bassman: { look: 'tweed', name: "Tweed '59" },
  twin: { look: 'blackface', name: "Blackface '69" },
  jcm800: { look: 'plexi', name: 'British 800' },
  jtm45: { look: 'plexi45', name: 'British 45' },
  ac30: { look: 'copper', name: 'Top Boost' },
  soldano: { look: 'chrome', name: 'Chrome 100' },
};

/** Put the look for `stack` on the page. */
export function setVoice(stack) {
  const v = VOICES[stack] || VOICES.jcm800;
  const app = document.getElementById('app');
  if (app) app.dataset.voice = v.look;
  const name = document.getElementById('np-name');
  const after = document.getElementById('np-after');
  if (name) name.textContent = v.name;
  if (after) after.textContent = STACKS[stack] ? `after the ${STACKS[stack].name}` : '';
}
