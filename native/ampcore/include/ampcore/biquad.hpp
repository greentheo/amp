// A biquad that behaves like Web Audio's BiquadFilterNode.
//
// The cab's impulse response is rendered in the browser by pushing a click
// through six BiquadFilterNodes, so a native cab that is the same cab needs
// the same filters — not the same *kind* of filter, the same arithmetic.
// That means Chromium's coefficient formulas (lowpass and highpass take Q in
// decibels, peaking and shelving take it linear), normalised by multiplying
// with 1/a0 rather than dividing, and parameters that arrive as 32-bit floats
// because every AudioParam is one.
//
// The feedback state is double, and that was settled by measurement rather
// than assumed — the assumption was wrong. Holding it as float (rounding each
// output before feeding it back) matched Chrome to only -100 to -139 dB;
// double matched to -146 to -155, on all four filter types the cab uses.
// That is below what 24-bit audio can represent, though not bit-exact the
// way the amp is: Chrome on macOS appears to hand its biquads to Accelerate,
// whose internal order of operations cannot be reproduced exactly.

#pragma once
#include <algorithm>
#include <cmath>

namespace ampcore {

class Biquad {
public:
    enum Type { Lowpass, Highpass, Peaking, Lowshelf };

    /**
     * @param hz, q, db exactly as the AudioParams would hold them — this
     *   rounds them to float itself, so pass the JS-side values
     */
    Biquad(Type type, double rate, double hz, double q, double db = 0) {
        const double f = static_cast<float>(hz);
        q = static_cast<float>(q);
        db = static_cast<float>(db);
        const double nyquist = 0.5 * rate;
        double fn = f / nyquist;
        switch (type) {
        case Lowpass: lowpass(std::min(1.0, std::max(0.0, fn)), q); break;
        case Highpass: highpass(std::min(1.0, std::max(0.0, fn)), q); break;
        case Peaking: peaking(std::min(1.0, std::max(0.0, fn)), q, db); break;
        case Lowshelf: lowshelf(std::min(1.0, std::max(0.0, fn)), db); break;
        }
    }

    /** Round the fed-back output to float each sample (false, measured: see
     *  the top of the file). Switchable only so the test can re-check it. */
    inline static bool floatState = false;

    void process(const float* in, float* out, int n) {
        double x1 = x1_, x2 = x2_, y1 = y1_, y2 = y2_;
        for (int i = 0; i < n; i++) {
            const float x = in[i];
            const double yd = b0_ * x + b1_ * x1 + b2_ * x2 - a1_ * y1 - a2_ * y2;
            const float y = static_cast<float>(yd);
            out[i] = y;
            x2 = x1; x1 = x;
            y2 = y1; y1 = floatState ? static_cast<double>(y) : yd;
        }
        x1_ = x1; x2_ = x2; y1_ = y1; y2_ = y2;
    }

private:
    void set(double b0, double b1, double b2, double a0, double a1, double a2) {
        const double inv = 1 / a0;
        b0_ = b0 * inv; b1_ = b1 * inv; b2_ = b2 * inv; a1_ = a1 * inv; a2_ = a2 * inv;
    }

    void lowpass(double cutoff, double resonance) {
        if (cutoff == 1) return set(1, 0, 0, 1, 0, 0);
        if (cutoff <= 0) return set(0, 0, 0, 1, 0, 0);
        const double g = std::pow(10.0, -0.05 * resonance);
        const double w0 = M_PI * cutoff;
        const double cw = std::cos(w0);
        const double alpha = 0.5 * std::sin(w0) * g;
        const double b1 = 1.0 - cw, b0 = 0.5 * b1;
        set(b0, b1, b0, 1.0 + alpha, -2.0 * cw, 1.0 - alpha);
    }

    void highpass(double cutoff, double resonance) {
        if (cutoff == 1) return set(0, 0, 0, 1, 0, 0);
        if (cutoff <= 0) return set(1, 0, 0, 1, 0, 0);
        const double g = std::pow(10.0, -0.05 * resonance);
        const double w0 = M_PI * cutoff;
        const double cw = std::cos(w0);
        const double alpha = 0.5 * std::sin(w0) * g;
        const double b1 = -1.0 - cw, b0 = -0.5 * b1;
        set(b0, b1, b0, 1.0 + alpha, -2.0 * cw, 1.0 - alpha);
    }

    void peaking(double frequency, double q, double dbGain) {
        q = std::max(0.0, q);
        const double a = std::pow(10.0, dbGain / 40);
        if (frequency > 0 && frequency < 1) {
            if (q > 0) {
                const double w0 = M_PI * frequency;
                const double alpha = std::sin(w0) / (2 * q);
                const double k = std::cos(w0);
                set(1 + alpha * a, -2 * k, 1 - alpha * a, 1 + alpha / a, -2 * k, 1 - alpha / a);
            } else {
                set(a * a, 0, 0, 1, 0, 0);
            }
        } else {
            set(1, 0, 0, 1, 0, 0);
        }
    }

    void lowshelf(double frequency, double dbGain) {
        const double a = std::pow(10.0, dbGain / 40);
        if (frequency == 1) return set(a * a, 0, 0, 1, 0, 0);
        if (frequency <= 0) return set(1, 0, 0, 1, 0, 0);
        const double w0 = M_PI * frequency;
        const double s = 1;
        const double alpha = 0.5 * std::sin(w0) * std::sqrt((a + 1 / a) * (1 / s - 1) + 2);
        const double k = std::cos(w0);
        const double k2 = 2 * std::sqrt(a) * alpha;
        const double ap = a + 1, am = a - 1;
        set(a * (ap - am * k + k2), 2 * a * (am - ap * k), a * (ap - am * k - k2),
            ap + am * k + k2, -2 * (am + ap * k), ap + am * k - k2);
    }

    double b0_ = 1, b1_ = 0, b2_ = 0, a1_ = 0, a2_ = 0;
    double x1_ = 0, x2_ = 0, y1_ = 0, y2_ = 0;
};

}  // namespace ampcore
