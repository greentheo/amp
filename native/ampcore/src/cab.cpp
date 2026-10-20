#include "ampcore/cab.hpp"

#include <cmath>
#include <cstdint>

#include "ampcore/biquad.hpp"

namespace ampcore {

namespace {

const std::map<std::string, std::map<std::string, double>> SPEAKERS = {
    {"g12m", {{"res", 247}, {"resQ", 4.2}, {"pres", 2400}, {"presDb", 3.45}, {"top", 2529}, {"tilt", -11.98}}},
    {"g12t", {{"res", 286}, {"resQ", 4.96}, {"pres", 3300}, {"presDb", 4.59}, {"top", 2859}, {"tilt", -10.98}}},
    {"v30", {{"res", 260}, {"resQ", 4.58}, {"pres", 3951}, {"presDb", 5.17}, {"top", 2749}, {"tilt", -9.98}}},
    {"jensen", {{"res", 338}, {"resQ", 3.44}, {"pres", 2000}, {"presDb", 2.87}, {"top", 3079}, {"tilt", -8.98}}},
    {"blue", {{"res", 221}, {"resQ", 3.82}, {"pres", 2800}, {"presDb", 4.02}, {"top", 3298}, {"tilt", -8.98}}},
};

const std::map<std::string, double> CAB_SHAPE = {
    {"hp", 115}, {"hpQ", 1.59}, {"resDb", 3.53}, {"presQ", 3.52},
    {"topQ", 0.56}, {"top2", 2.5}, {"top2Q", 1.5}, {"tiltHz", 931},
};

/** Math.round: nearest integer, halves toward +infinity. */
double jsRound(double x) {
    double r = std::floor(x);
    if (x - r >= 0.5) r += 1;
    return r;
}

/** ToInt32, as JavaScript's bitwise operators apply it. */
uint32_t toUint32Bits(double x) {
    const double m = std::fmod(std::trunc(x), 4294967296.0);
    return static_cast<uint32_t>(static_cast<int64_t>(m < 0 ? m + 4294967296.0 : m));
}

/** seedOf() in cab.js: FNV-style over the speaker id, then the sorted
 *  numeric options rounded to thousandths. std::map iterates in the same
 *  sorted order as Object.keys().sort() for these ASCII keys. */
uint32_t seedOf(const std::map<std::string, double>& spec, const std::string& speaker) {
    uint32_t h = 2166136261u;
    auto mix = [&](uint32_t x) { h = (h ^ x) * 16777619u; };
    for (unsigned char c : speaker) mix(c);
    for (const auto& kv : spec) mix(toUint32Bits(jsRound(kv.second * 1000)));
    return h;
}

/** mulberry32, with JavaScript's 32-bit integer semantics. */
struct Mulberry32 {
    uint32_t a;
    double next() {
        a += 0x6d2b79f5u;
        uint32_t t = (a ^ (a >> 15)) * (1u | a);
        t = (t + ((t ^ (t >> 7)) * (61u | t))) ^ t;
        return static_cast<double>(t ^ (t >> 14)) / 4294967296.0;
    }
};

}  // namespace

std::vector<float> renderCab(double rate, const CabOpts& opts) {
    const auto spIt = SPEAKERS.find(opts.speaker);
    const auto& sp = spIt != SPEAKERS.end() ? spIt->second : SPEAKERS.at("v30");
    // { ...CAB_SHAPE, ...SPEAKERS[speaker], ...opts } — later wins.
    std::map<std::string, double> spec = CAB_SHAPE;
    for (const auto& kv : sp) spec[kv.first] = kv.second;
    for (const auto& kv : opts.num) spec[kv.first] = kv.second;
    auto get = [&](const char* k) { return spec.at(k); };
    const double axis = opts.num.count("axis") ? opts.num.at("axis") : 0.6;
    const double distance = opts.num.count("distance") ? opts.num.at("distance") : 0.25;

    const int len = static_cast<int>(jsRound(rate * 0.09));
    std::vector<float> d(len, 0.0f);
    d[0] = 1;
    const double bounces[5][2] = {{0.0011, -0.42}, {0.0023, 0.26}, {0.0041, -0.18}, {0.0067, 0.12}, {0.011, -0.07}};
    for (const auto& b : bounces) {
        const int i = static_cast<int>(jsRound(b[0] * rate));
        if (i < len) d[i] = static_cast<float>(d[i] + b[1] * (0.35 + distance * 1.3));
    }
    Mulberry32 rnd{seedOf(spec, opts.speaker)};
    for (int i = 1; i < len; i++) {
        d[i] = static_cast<float>(d[i] + (rnd.next() * 2 - 1) * 0.06 * std::exp((-i / rate) * 420));
    }

    Biquad hp(Biquad::Highpass, rate, get("hp"), get("hpQ"));
    Biquad res(Biquad::Peaking, rate, get("res"), get("resQ"), get("resDb"));
    Biquad pres(Biquad::Peaking, rate, get("pres") * (0.75 + axis * 0.5), get("presQ"), get("presDb") * (0.45 + axis * 0.9));
    Biquad tilt(Biquad::Lowshelf, rate, get("tiltHz"), 0, -get("tilt") + distance * 3);
    Biquad lp(Biquad::Lowpass, rate, get("top") * (0.72 + axis * 0.55), get("topQ"));
    Biquad lp2(Biquad::Lowpass, rate, get("top") * get("top2"), get("top2Q"));
    // hp -> res -> pres -> tilt -> lp -> lp2, each node's output a float buffer.
    std::vector<float> o(len);
    hp.process(d.data(), o.data(), len);
    res.process(o.data(), d.data(), len);
    pres.process(d.data(), o.data(), len);
    tilt.process(o.data(), d.data(), len);
    lp.process(d.data(), o.data(), len);
    lp2.process(o.data(), d.data(), len);
    o = d;

    // Normalise by energy, then fade the tail — in double, stored as float.
    double energy = 0;
    for (int i = 0; i < len; i++) energy += static_cast<double>(o[i]) * o[i];
    const double norm = energy > 1e-12 ? 1 / std::sqrt(energy) : 1;
    for (int i = 0; i < len; i++) o[i] = static_cast<float>(o[i] * norm);
    const int fade = static_cast<int>(jsRound(len * 0.25));
    for (int i = 0; i < fade; i++) o[len - fade + i] = static_cast<float>(o[len - fade + i] * (1 - static_cast<double>(i) / fade));
    return o;
}

}  // namespace ampcore
