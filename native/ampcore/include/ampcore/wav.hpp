// Minimal WAV reading and writing for the command-line tools.
//
// Reads PCM 16/24/32 and float 32/64, walking the chunks rather than assuming
// offsets, and summing to mono — the same tolerance tools/lib/wavio.mjs has,
// for the same reason: captures come out of whatever recorded them. Writes
// 32-bit float, so a null test is not limited by 16-bit quantisation.

#pragma once
#include <cstdint>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace ampcore {

struct Wav {
    double rate = 0;
    std::vector<float> mono;
};

inline Wav readWav(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("cannot open " + path);
    std::vector<uint8_t> b((std::istreambuf_iterator<char>(f)), {});
    auto u16 = [&](size_t o) { return uint16_t(b[o] | b[o + 1] << 8); };
    auto u32 = [&](size_t o) { return uint32_t(b[o] | b[o + 1] << 8 | b[o + 2] << 16 | uint32_t(b[o + 3]) << 24); };
    if (b.size() < 12 || std::memcmp(&b[0], "RIFF", 4) || std::memcmp(&b[8], "WAVE", 4))
        throw std::runtime_error(path + ": not a RIFF/WAVE file");
    int format = 0, channels = 0, bits = 0;
    uint32_t rate = 0;
    size_t dataOff = 0, dataLen = 0;
    for (size_t off = 12; off + 8 <= b.size();) {
        const uint32_t size = u32(off + 4);
        const size_t body = off + 8;
        if (!std::memcmp(&b[off], "fmt ", 4)) {
            format = u16(body);
            channels = u16(body + 2);
            rate = u32(body + 4);
            bits = u16(body + 14);
            if (format == 0xfffe && size >= 40) format = u16(body + 24);
        } else if (!std::memcmp(&b[off], "data", 4)) {
            dataOff = body;
            dataLen = (size == 0 || size == 0xffffffff) ? b.size() - body : std::min<size_t>(size, b.size() - body);
        }
        off = body + size + (size & 1);
    }
    if (!format || !dataOff) throw std::runtime_error(path + ": missing fmt or data chunk");
    const int bytes = bits / 8;
    const size_t frames = dataLen / (size_t(bytes) * channels);
    Wav w;
    w.rate = rate;
    w.mono.assign(frames, 0.0f);
    for (size_t i = 0; i < frames; i++) {
        double acc = 0;
        for (int c = 0; c < channels; c++) {
            const size_t o = dataOff + (i * channels + c) * bytes;
            double v;
            if (format == 3 && bits == 32) { float x; std::memcpy(&x, &b[o], 4); v = x; }
            else if (format == 3 && bits == 64) { double x; std::memcpy(&x, &b[o], 8); v = x; }
            else if (format == 1 && bits == 16) v = int16_t(u16(o)) / 32768.0;
            else if (format == 1 && bits == 24) {
                int32_t x = b[o] | b[o + 1] << 8 | b[o + 2] << 16;
                if (x & 0x800000) x -= 0x1000000;
                v = x / 8388608.0;
            } else if (format == 1 && bits == 32) v = int32_t(u32(o)) / 2147483648.0;
            else throw std::runtime_error(path + ": unsupported format");
            acc += v;
        }
        // Mono files pass through untouched — no division, no rounding.
        w.mono[i] = channels == 1 ? static_cast<float>(acc) : static_cast<float>(acc / channels);
    }
    return w;
}

inline void writeWavFloat(const std::string& path, const std::vector<float>& x, double rate) {
    std::ofstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("cannot write " + path);
    auto w32 = [&](uint32_t v) { f.put(v & 255); f.put(v >> 8 & 255); f.put(v >> 16 & 255); f.put(v >> 24 & 255); };
    auto w16 = [&](uint16_t v) { f.put(v & 255); f.put(v >> 8 & 255); };
    const uint32_t data = static_cast<uint32_t>(x.size() * 4);
    f.write("RIFF", 4); w32(36 + data); f.write("WAVE", 4);
    f.write("fmt ", 4); w32(16); w16(3); w16(1); w32(uint32_t(rate)); w32(uint32_t(rate) * 4); w16(4); w16(32);
    f.write("data", 4); w32(data);
    f.write(reinterpret_cast<const char*>(x.data()), data);
}

}  // namespace ampcore
