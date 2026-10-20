// The 4x polyphase up/down pair the amp and the clipping pedals run inside.
//
// A 64-tap Blackman-windowed sinc with its corner at 11 kHz, rounded to
// float at the same two points the JS rounds it (Float32Array taps, then
// normalised and stored again), with a float delay line on each side and
// double accumulators. The browser copies this into amp-worklet.js and
// pedal-worklet.js separately; here there is one.

#pragma once
#include <array>
#include <cmath>

namespace ampcore {

class Resampler {
public:
    static constexpr int OS = 4;
    static constexpr int TAPS = 16 * OS;
    static constexpr double CUT_HZ = 11000;

    explicit Resampler(double sampleRate) {
        const double cutoff = CUT_HZ / (sampleRate * OS);
        const double c = (TAPS - 1) / 2.0;
        double sum = 0;
        for (int i = 0; i < TAPS; i++) {
            const double x = i - c;
            const double sinc = std::fabs(x) < 1e-9 ? 2 * cutoff : std::sin(2 * M_PI * cutoff * x) / (M_PI * x);
            const double w = 0.42 - 0.5 * std::cos((2 * M_PI * i) / (TAPS - 1))
                + 0.08 * std::cos((4 * M_PI * i) / (TAPS - 1));
            h_[i] = static_cast<float>(sinc * w);
            sum += h_[i];
        }
        for (int i = 0; i < TAPS; i++) h_[i] = static_cast<float>(h_[i] / sum);
        for (int p = 0; p < OS; p++)
            for (int k = 0; k < TAPS / OS; k++) {
                const int idx = k * OS + p;
                phases_[p][k] = idx < TAPS ? static_cast<float>(h_[idx] * OS) : 0.0f;
            }
    }

    /** One input sample in, OS samples out, each rounded to float. */
    void up(double x, float* out) {
        auto& line = upLine_;
        for (int i = static_cast<int>(line.size()) - 1; i > 0; i--) line[i] = line[i - 1];
        line[0] = static_cast<float>(x);
        for (int p = 0; p < OS; p++) {
            const auto& b = phases_[p];
            double acc = 0;
            for (size_t k = 0; k < b.size(); k++) acc += static_cast<double>(b[k]) * line[k];
            out[p] = static_cast<float>(acc);
        }
    }

    /** OS samples in, one out — not rounded, as the JS returns it. */
    double down(const float* buf) {
        auto& line = downLine_;
        for (int i = TAPS - 1; i >= OS; i--) line[i] = line[i - OS];
        for (int p = 0; p < OS; p++) line[OS - 1 - p] = buf[p];
        double acc = 0;
        for (int i = 0; i < TAPS; i++) acc += static_cast<double>(h_[i]) * line[i];
        return acc;
    }

    void reset() {
        upLine_.fill(0);
        downLine_.fill(0);
    }

private:
    std::array<float, TAPS> h_;
    std::array<std::array<float, TAPS / OS>, OS> phases_;
    std::array<float, TAPS / OS> upLine_{};
    std::array<float, TAPS> downLine_{};
};

}  // namespace ampcore
