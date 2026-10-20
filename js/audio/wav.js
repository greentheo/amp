// WAV encoding for AudioBuffers, so recorded audio can travel inside a
// session file. A forged source can be regenerated from its description and a
// dropped file still exists on disk, but a capture of someone playing exists
// nowhere else — if it is not in the session, it is gone.

/** @returns {ArrayBuffer} 16-bit PCM WAV */
export function encodeWav(buffer) {
  const chans = Math.min(2, buffer.numberOfChannels);
  const frames = buffer.length;
  const rate = buffer.sampleRate;
  const bytes = 44 + frames * chans * 2;
  const view = new DataView(new ArrayBuffer(bytes));

  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  view.setUint32(4, bytes - 8, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, chans, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * chans * 2, true);
  view.setUint16(32, chans * 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, frames * chans * 2, true);

  const data = [];
  for (let c = 0; c < chans; c++) data.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < chans; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      off += 2;
    }
  }
  return view.buffer;
}

/**
 * 32-bit float WAV, mono, from one channel (the first unless told). For
 * reference renders: the null test against the native build compares to
 * around -150 dB, and 16-bit quantisation would put a floor at -96 under
 * everything.
 * @returns {ArrayBuffer}
 */
export function encodeWavFloat(buffer, channel = 0) {
  const d = buffer.getChannelData(channel);
  const rate = buffer.sampleRate;
  const bytes = 44 + d.length * 4;
  const view = new DataView(new ArrayBuffer(bytes));
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, bytes - 8, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 32, true);
  str(36, 'data'); view.setUint32(40, d.length * 4, true);
  for (let i = 0; i < d.length; i++) view.setFloat32(44 + i * 4, d[i], true);
  return view.buffer;
}

/** Chunked, because spreading a megabyte into fromCharCode blows the stack. */
export function toBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const step = 0x8000;
  let s = '';
  for (let i = 0; i < bytes.length; i += step) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(s);
}

export function fromBase64(b64) {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out.buffer;
}

/** Rough size of the encoded audio, for warning before a save. */
export function sizeOf(buffer) {
  const chans = Math.min(2, buffer.numberOfChannels);
  return 44 + buffer.length * chans * 2;
}
