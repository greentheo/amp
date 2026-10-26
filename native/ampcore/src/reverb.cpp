#include "ampcore/reverb.hpp"

#include <algorithm>
#include <cmath>

#include "ampcore/jsmath.hpp"

namespace ampcore {

std::vector<std::vector<float>> springIR(double rate) {
    // springIR() in engine.js, which says why it is shaped the way it is.
    const int len = static_cast<int>(jsRound(rate * 1.6));
    std::vector<std::vector<float>> ch(2, std::vector<float>(static_cast<size_t>(len)));
    Mulberry32 rnd{0x5eed5};
    const double kLow = 1 - std::exp((-2 * M_PI * 150) / rate);
    for (size_t c = 0; c < 2; c++) {
        auto& d = ch[c];
        const double trip = c == 0 ? 0.0291 : 0.0367;
        double lp1 = 0, lp2 = 0, low = 0;
        for (int i = 0; i < len; i++) {
            const double t = i / rate;
            const double env = std::exp(-t * 3.6);
            const double depth = 0.6 * std::exp(-t * 4);
            const double echo = 1 - depth + depth * 2.2 * std::exp(-(std::fmod(t, trip) / trip) * 7);
            const double n = (rnd.next() * 2 - 1) * env * echo;
            const double k = 1 - std::exp((-2 * M_PI * (1800 + 3200 * std::exp(-t * 2.5))) / rate);
            lp1 += (n - lp1) * k;
            lp2 += (lp1 - lp2) * k;
            low += (lp2 - low) * kLow;
            d[static_cast<size_t>(i)] = static_cast<float>(lp2 - low);
        }
    }
    return ch;
}

float webAudioNormalizeScale(const std::vector<std::vector<float>>& ir, double rate) {
    // Chromium sums the squares with vector_math::Vsvesq, in float, in an
    // order Accelerate chooses. Sum in double and round once instead: the
    // true power to float precision, which Chromium's approximates.
    //
    // Measured against Chrome on the spring: its scale comes out 3.3e-7
    // (five float ulps) above this one, and no plain float order matches it
    // — sequential is 5.6e-5 off, and accumulating in 4 to 32 lanes closes
    // to within an ulp without landing on it. That level difference is most
    // of the reverb's -128 dB null; with it fitted out the rest is -133.
    float power = 0;
    for (const auto& c : ir) {
        double s = 0;
        for (float v : c) s += static_cast<double>(v) * v;
        power += static_cast<float>(s);
    }
    const unsigned count = static_cast<unsigned>(ir.size() * ir[0].size());
    power = std::sqrt(power / static_cast<float>(count));
    if (!std::isfinite(power) || power < 0.000125f) power = 0.000125f;
    float scale = 1 / power;
    scale *= std::pow(10.0f, -58.0f * 0.05f);
    scale *= 44100.0f / static_cast<float>(rate);
    if (ir.size() == 4) scale *= 0.5f;
    return scale;
}

namespace {
double scaleFor(const std::vector<std::vector<float>>& ir, double rate, bool normalize) {
    return normalize ? webAudioNormalizeScale(ir, rate) : 1.0;
}
}  // namespace

Reverb::Reverb(const std::vector<std::vector<float>>& ir, double rate, bool normalize, int partition)
    : left_(ir[0], scaleFor(ir, rate, normalize), partition),
      right_(ir.size() > 1 ? ir[1] : ir[0], scaleFor(ir, rate, normalize), partition) {}

void Reverb::process(const float* in, float* outL, float* outR, int n) {
    left_.process(in, outL, n);
    right_.process(in, outR, n);
}

void Reverb::reset() {
    left_.reset();
    right_.reset();
}

}  // namespace ampcore
