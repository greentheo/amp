// JavaScript's number semantics, where the browser build leans on them.
//
// The cab and the spring reverb both generate their impulse responses from
// seeded noise, so the native build has to draw exactly the same numbers —
// which means Math.round's tie-breaking, ToInt32's wrapping, and
// mulberry32 with Math.imul's 32-bit multiply.

#pragma once
#include <cmath>
#include <cstdint>

namespace ampcore {

/** Math.round: nearest integer, halves toward +infinity. */
inline double jsRound(double x) {
    double r = std::floor(x);
    if (x - r >= 0.5) r += 1;
    return r;
}

/** ToInt32, as JavaScript's bitwise operators apply it, as raw bits. */
inline uint32_t toUint32Bits(double x) {
    const double m = std::fmod(std::trunc(x), 4294967296.0);
    return static_cast<uint32_t>(static_cast<int64_t>(m < 0 ? m + 4294967296.0 : m));
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

}  // namespace ampcore
