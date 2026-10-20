// The engine behind the page when it runs inside the native app.
//
// Same surface as Engine, as far as the page uses it, so app.js and the
// pedalboard do not care which one they are talking to. Where Engine drives
// Web Audio, this sends each change to the native processor over JUCE's
// bridge (window.__JUCE__.backend) as an "amp" event, and the processor does
// the sound. It answers "hello" with its saved settings and keeps a level
// meter and the device's latency coming back.
//
// What only a browser can do — pick devices, record, measure the lag, render
// the calibration stimulus — the page hides in the app, which has its own
// audio settings dialog instead. See native/app/src/Editor.cpp for the other
// end.

import { renderCab } from './cab.js';
import { defaultBoard, findPedal, restoreBoard } from './pedals.js';

/** True inside the native app's WebView. */
export const isNative = () => typeof window.__JUCE__?.backend?.emitEvent === 'function';

export class NativeEngine {
  constructor() {
    this.native = true;
    this.ctx = null;         // a stand-in once connected: the page reads it as "powered on"
    this.analyser = null;    // no spectrum yet; the page skips the scope without one
    this.board = defaultBoard();
    this.voicing = {};
    this.cabOpts = { speaker: 'v30', axis: 0.6, distance: 0.25 };
    this.tone = { stack: 'jcm800', bass: 0.5, mid: 0.5, treble: 0.6 };
    this.requested = {};
    this.cab = null;         // { buffer }, rendered here only to draw the curve
    this.irData = null;
    this.sinkId = '';
    this.opts = { latencyHint: 0 };
    this.audio = {};
    this.saved = null;
    this.peak = 0;
    this.onAudio = null;
    const backend = window.__JUCE__.backend;
    this.backend = backend;
    // The peak of the last ~33 ms, as the browser's analyser window gives it.
    backend.addEventListener('meter', (e) => { this.peak = e.peak; });
    backend.addEventListener('audio', (a) => {
      this.audio = a || {};
      if (this.ctx && this.audio.rate) this.ctx.sampleRate = this.audio.rate;
      if (this.onAudio) this.onAudio(this.audio);
    });
  }

  send(msg) { if (!this.quiet) this.backend.emitEvent('amp', msg); }

  /**
   * Take the app's settings, which arrive with the page as JUCE
   * initialisation data, and return them (chainSettings() form). The app is
   * the source of truth: the page shows what it holds and sends what you
   * change, and never pushes its own values over the app's.
   *
   * The app also answers "hello" with them, for a page reloaded after the
   * app opened it. That copy is applied whenever it comes, with no timeout
   * to race against, through `onState`.
   */
  connect() {
    const init = window.__JUCE__.initialisationData || {};
    this.adopt(init.ampState?.[0] || null, init.ampAudio?.[0] || {});
    this.backend.addEventListener('state', (s) => {
      if (s.audio) this.audio = s.audio;
      if (this.onState && s.settings) this.onState(s.settings);
    });
    this.send({ type: 'hello' });
    return this.saved;
  }

  adopt(settings, audio) {
    this.saved = settings;
    this.audio = audio;
    if (!settings) return;
    if (settings.board) this.board = restoreBoard(settings.board);
    if (settings.cab) this.cabOpts = { ...settings.cab };
    if (settings.voicing) this.voicing = { ...settings.voicing };
    if (settings.tone) Object.assign(this.tone, settings.tone);
  }

  /** Run `fn` with sending switched off: for putting the app's own settings
   *  on the panel, which would otherwise echo every one of them back. */
  quietly(fn) {
    this.quiet = (this.quiet || 0) + 1;
    try { return fn(); } finally { this.quiet--; }
  }

  async init() {
    if (this.ctx) return;
    const now = () => performance.now() / 1000;
    this.ctx = { sampleRate: this.audio.rate || 48000, get currentTime() { return now(); } };
    // A first launch has no board of its own: give it the page's.
    if (!this.saved?.board) this.send({ type: 'board', board: this.board });
    await this.drawableCab();
  }

  async resume() {}

  set(name, value) {
    this.requested[name] = value;
    this.send({ type: 'set', name, value });
  }

  setTone(t) {
    Object.assign(this.tone, t);
    this.send({ type: 'tone', ...t });
  }

  async setCab(opts) {
    this.cabOpts = { ...this.cabOpts, ...opts };
    for (const k of Object.keys(this.cabOpts)) if (this.cabOpts[k] == null) delete this.cabOpts[k];
    this.send({ type: 'cab', opts });
    await this.drawableCab();
  }

  async drawableCab() {
    // renderCab wants a context to make its buffer in; a one-frame offline
    // one at the app's rate is enough, since nothing here plays.
    const ctx = new OfflineAudioContext(1, 1, this.ctx?.sampleRate || 48000);
    this.cab = { buffer: await renderCab(ctx, this.cabOpts) };
  }

  async loadIR() {
    throw new Error('loading an impulse response file is not in the app yet');
  }

  setVoicing(v) {
    Object.assign(this.voicing, v);
    this.send({ type: 'voicing', v: this.voicing });
  }

  resetVoicing() {
    this.voicing = {};
    this.send({ type: 'voicing', v: {} });
  }

  async setBoard(board) {
    this.board = board;
    this.send({ type: 'board', board });
  }

  setPedalValue(id, k, v) {
    const hit = findPedal(this.board, id);
    if (!hit) return;
    hit.pedal.values[k] = v;
    this.send({ type: 'pedal', uid: id, k, v });
  }

  setPedalOn(id, on) {
    const hit = findPedal(this.board, id);
    if (!hit) return;
    hit.pedal.on = !!on;
    this.send({ type: 'pedalOn', uid: id, on: !!on });
  }

  /** The output's recent peak. */
  level() { return this.peak; }

  /** What the device driver reports. The cable loop has measured more than
   *  this every time, so it is a floor, not the round trip. */
  latency() {
    const a = this.audio;
    if (!a.rate) return null;
    const ms = (frames) => ((frames || 0) / a.rate) * 1000;
    const input = ms(a.inLatency), base = ms(a.buffer), out = ms(a.outLatency);
    return { input, base, out, total: input + base + out, measured: false };
  }

  inputRate() { return null; }

  panic() { this.send({ type: 'panic' }); }

  showAudioSettings() { this.send({ type: 'audioSettings' }); }
}

/** Page errors to the app's log (~/Library/Logs/Amp/amp.log): a release
 *  build's WebView has no inspector to read them in. */
export function forwardConsole(engine) {
  const send = (level, args) => {
    try {
      const text = args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(' ');
      engine.send({ type: 'log', level, text });
    } catch {}
  };
  for (const level of ['error', 'warn']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => { send(level, args); orig(...args); };
  }
  addEventListener('error', (e) => send('error', [e.error || e.message]));
  addEventListener('unhandledrejection', (e) => send('error', [e.reason]));
}
