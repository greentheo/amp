// Reading and writing WAV from node, for the calibration tools.
//
// The reading side has to be forgiving, because the captures come out of
// whatever the user recorded with: Logic writes 24-bit PCM, QuickTime writes
// 16-bit, Reaper defaults to 32-bit float, and anything that went near a
// multichannel path writes WAVE_FORMAT_EXTENSIBLE with the real format hidden
// in a GUID. All of those have to land as Float32 without comment.

import { readFileSync, writeFileSync } from 'node:fs';

const PCM = 1, FLOAT = 3, EXTENSIBLE = 0xfffe;

/**
 * @param {string} path
 * @returns {{rate:number, channels:number, data:Float32Array[], frames:number}}
 */
export function readWav(path) {
  const buf = readFileSync(path);
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error(`${path}: not a RIFF/WAVE file`);
  }

  let fmt = null, dataOff = -1, dataLen = 0;
  // Chunks are walked rather than assumed at fixed offsets: anything that has
  // been through an editor carries LIST/bext/iXML chunks before the data.
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      let format = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const rate = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      // The extensible header's real format is the first two bytes of the
      // subformat GUID, 24 bytes into the extension.
      if (format === EXTENSIBLE && size >= 40) format = buf.readUInt16LE(body + 24);
      fmt = { format, channels, rate, bits };
    } else if (id === 'data') {
      dataOff = body;
      // A size of 0 or 0xffffffff means "streamed, read to the end", which is
      // what a recording that was not closed cleanly looks like.
      dataLen = size === 0 || size === 0xffffffff ? buf.length - body : Math.min(size, buf.length - body);
    }
    off = body + size + (size & 1);          // chunks are word-aligned
  }
  if (!fmt) throw new Error(`${path}: no fmt chunk`);
  if (dataOff < 0) throw new Error(`${path}: no data chunk`);

  const { format, channels, rate, bits } = fmt;
  const bytes = bits >> 3;
  const frames = Math.floor(dataLen / (bytes * channels));
  const data = Array.from({ length: channels }, () => new Float32Array(frames));

  const read = sampleReader(format, bits, path);
  for (let i = 0; i < frames; i++) {
    const base = dataOff + i * bytes * channels;
    for (let c = 0; c < channels; c++) data[c][i] = read(buf, base + c * bytes);
  }
  return { rate, channels, data, frames };
}

function sampleReader(format, bits, path) {
  if (format === FLOAT && bits === 32) return (b, o) => b.readFloatLE(o);
  if (format === FLOAT && bits === 64) return (b, o) => b.readDoubleLE(o);
  if (format === PCM) {
    if (bits === 8) return (b, o) => (b.readUInt8(o) - 128) / 128;      // 8-bit is unsigned
    if (bits === 16) return (b, o) => b.readInt16LE(o) / 32768;
    if (bits === 24) return (b, o) => {
      // No readInt24, so sign-extend by hand.
      const v = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
      return (v & 0x800000 ? v - 0x1000000 : v) / 8388608;
    };
    if (bits === 32) return (b, o) => b.readInt32LE(o) / 2147483648;
  }
  throw new Error(`${path}: unsupported format ${format} at ${bits}-bit`);
}

/** Average the channels down to one, which is what every analysis here wants. */
export function mono(wav) {
  if (wav.channels === 1) return wav.data[0];
  const out = new Float32Array(wav.frames);
  for (let c = 0; c < wav.channels; c++) {
    const d = wav.data[c];
    for (let i = 0; i < wav.frames; i++) out[i] += d[i] / wav.channels;
  }
  return out;
}

/**
 * 24-bit PCM out, because the stimulus has a -30 dBFS section and 16 bits
 * puts the quantisation floor uncomfortably close to it.
 */
export function writeWav(path, samples, rate) {
  const frames = samples.length;
  const bytes = 44 + frames * 3;
  const buf = Buffer.alloc(bytes);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(bytes - 8, 4);
  buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(PCM, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 3, 28);
  buf.writeUInt16LE(3, 32);
  buf.writeUInt16LE(24, 34);
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(frames * 3, 40);
  for (let i = 0; i < frames; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    const q = Math.round(v < 0 ? v * 8388608 : v * 8388607);
    const o = 44 + i * 3;
    buf[o] = q & 0xff; buf[o + 1] = (q >> 8) & 0xff; buf[o + 2] = (q >> 16) & 0xff;
  }
  writeFileSync(path, buf);
  return bytes;
}
