#include "ampcore/tuner.hpp"

#include <algorithm>
#include <cmath>

namespace ampcore {

namespace {

// A dip in the normalised difference below this is a note: the first one
// wins, which is what keeps YIN off the octave below.
constexpr double THRESHOLD = 0.1;
// With no dip that deep, the deepest one still counts if it is under this.
constexpr double WORST = 0.35;
// Quieter than this (about -54 dBFS) is a string ringing out, or nothing.
constexpr double FLOOR = 0.002;
// The low-pass in front: two one-poles at this corner. Hiss is spread over
// the whole band and a guitar's pitch is not, so this takes out most of the
// noise; it also quietens the upper partials, which a stiff string pulls
// sharp of the fundamental and which would otherwise pull the reading too.
constexpr double CORNER = 1000;
// Time the low-pass gets to settle before the part that is analysed: 19 of
// its time constants, so what it started from is gone.
constexpr double SETTLE = 0.003;

}  // namespace

PitchDetector::PitchDetector(double rate)
    : rate_(rate),
      minTau_(std::max(2, static_cast<int>(std::floor(rate / MAX_HZ)))),
      maxTau_(static_cast<int>(std::ceil(rate / MIN_HZ))),
      pad_(static_cast<int>(std::ceil(rate * SETTLE))) {
    const double w = 2 * M_PI * CORNER / rate;
    a_ = w / (1 + w);
    d_.assign(static_cast<size_t>(maxTau_) + 2, 0.0);
    cm_.assign(static_cast<size_t>(maxTau_) + 2, 1.0);
    s_.assign(static_cast<size_t>(window()), 0.0);
    e_.assign(static_cast<size_t>(window()) + 1, 0.0);
}

int PitchDetector::window() const { return pad_ + 2 * maxTau_ + 2; }

Pitch PitchDetector::analyse(const float* x, int n) {
    Pitch p;
    const int need = window();
    if (n < need) return p;
    x += n - need;
    double* d = d_.data();
    double* cm = cm_.data();
    double* s = s_.data();
    double* e = e_.data();

    double sum = 0;
    for (int i = pad_; i < need; i++) sum += static_cast<double>(x[i]) * static_cast<double>(x[i]);
    p.rms = std::sqrt(sum / (need - pad_));
    if (p.rms < FLOOR) return p;

    // Filtered, and the running energy of the filtered signal, so the
    // energy of any stretch of it is one subtraction.
    double y1 = 0, y2 = 0;
    e[0] = 0;
    for (int i = 0; i < need; i++) {
        y1 += a_ * (static_cast<double>(x[i]) - y1);
        y2 += a_ * (y1 - y2);
        s[i] = y2;
    }
    const int len = need - pad_;
    for (int i = 0; i < len; i++) e[i + 1] = e[i] + s[pad_ + i] * s[pad_ + i];

    // The difference function d(tau), and d normalised by its running mean,
    // which starts at 1 rather than 0 so that tau = 0 never looks like a
    // match. Stop once past the bottom of the first dip under THRESHOLD.
    const int w = maxTau_;
    double running = 0;
    int best = -1;
    for (int tau = 1; tau <= maxTau_ + 1; tau++) {
        double acc = 0;
        for (int j = 0; j < w; j++) {
            const double v = s[pad_ + j] - s[pad_ + j + tau];
            acc += v * v;
        }
        d[tau] = acc;
        running += acc;
        cm[tau] = running > 0 ? acc * tau / running : 1;
        if (tau < minTau_ || tau > maxTau_) continue;
        if (best < 0) {
            if (cm[tau] < THRESHOLD) best = tau;
        } else if (cm[tau] < cm[best]) {
            best = tau;
        } else {
            break;
        }
    }

    // No dip deep enough: take the first one nearly as deep as the deepest,
    // if the deepest is any good at all.
    if (best < 0) {
        double g = 1e9;
        for (int tau = minTau_; tau <= maxTau_; tau++) g = std::min(g, cm[tau]);
        if (g > WORST) return p;
        for (int tau = minTau_; tau <= maxTau_; tau++) {
            if (cm[tau] > g + 0.05) continue;
            best = tau;
            while (best < maxTau_ && cm[best + 1] < cm[best]) best++;
            break;
        }
    }

    // The fine reading: a parabola through the peak of the correlation
    // normalised by the energy at each end, r / sqrt(E0 E1), and its two
    // neighbours. Unlike d, that is untouched by a note dying away, where d
    // leans toward longer lags as the far end of the window gets quieter.
    const double e0 = e[w];
    auto rho = [&](int tau) {
        const double e1 = e[tau + w] - e[tau];
        return e0 > 0 && e1 > 0 ? (e0 + e1 - d[tau]) / (2 * std::sqrt(e0 * e1)) : 0.0;
    };
    const double ra = rho(best - 1), rb = rho(best), rc = rho(best + 1);
    const double den = ra - 2 * rb + rc;
    double shift = den < 0 ? 0.5 * (ra - rc) / den : 0;
    if (shift > 1) shift = 1;
    if (shift < -1) shift = -1;
    p.hz = rate_ / (best + shift);
    p.clarity = std::max(0.0, 1 - cm[best]);
    return p;
}

}  // namespace ampcore
