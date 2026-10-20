// The amp: gate, 4x oversampling, preamp stages, tone stack, power amp,
// sag, transformer, presence. Ported from js/audio/amp-worklet.js.
//
// A faithful port rather than a rewrite. The JS keeps its state in doubles
// and stores a few buffers in Float32Array — the filter taps, the delay
// lines, the oversampled block, the output — and each of those is a
// rounding point. They are floats here and nothing else is, because the
// test that says this port is right is a null test against the browser
// build, and an extra or missing rounding is exactly the kind of difference
// that test exists to catch.

#pragma once
#include <array>

#include "ampcore/resampler.hpp"
#include "ampcore/tonestack.hpp"

namespace ampcore {

/** The preamp's voicing. Defaults are what the browser build ships. */
struct Voicing {
    double decades = 2.2;
    double scale = 0.07;
    bool soft = false;           // the 'soft' curve; 'exp' when false
    double knee = 2.0;
    double stageGain = 1.6;
    double stageGainDrive = 0.08;
    double makeup = 3.2;
    double paDrive = 1.0;
    double paKp = 1.0;
    double paKn = 1.0;
    double sagDepth = 0.55;
    double xfmrHp = 28;
    double xfmrLp = 7500;
    double presenceHz = 2000;
    double presenceAmt = 2.2;
    double out = 0.42;
    // [coupling-cap Hz, Miller Hz, kp, kn] per stage
    std::array<std::array<double, 4>, 4> stages = {{
        {14, 12000, 1.0, 0.7},
        {30, 10000, 1.1, 0.6},
        {60, 9000, 1.2, 0.55},
        {90, 8000, 1.3, 0.5},
    }};
};

/** The knobs that reach the amp. All k-rate, as in the worklet. */
struct AmpParams {
    double drive = 0.35;
    double bias = 0.0;
    double presence = 0.3;
    double sag = 0.3;
    double masterVol = 0.5;
    double gate = 0.0;
    double stages = 3;
};

class Amp {
public:
    static constexpr int OS = Resampler::OS;

    explicit Amp(double sampleRate, const Voicing& v = Voicing());

    void setVoicing(const Voicing& v);
    void setTone(const ToneCoeffs& k) { tone_ = k; hasTone_ = true; }
    void clearTone() { hasTone_ = false; }
    void reset();

    /**
     * Process a block with one set of parameters, which is what the worklet
     * does per 128-frame quantum. With parameters held constant the block
     * size makes no difference to the output.
     */
    void process(const float* in, float* out, int n, const AmpParams& p);

private:
    struct Stage {
        double aHp, aLp, aDc;
        double hp = 0, lp = 0, dc = 0;
        double kp, kn;
        bool soft;
        double knee;
        double run(double x, double gain, double bias);
    };

    void buildStages();
    void tuneOutput();

    double rate_, hi_;
    Voicing v_;
    std::array<Stage, 4> stages_;
    Resampler rs_;

    ToneCoeffs tone_{};
    bool hasTone_ = false;
    double tsState_[3] = {0, 0, 0};

    double ampHp_ = 0, ampLp_ = 0, presLp_ = 0;
    double aAmpHp_, aAmpLp_, aPres_;
    double sagEnv_ = 0, aSagUp_, aSagDn_;
    double gateEnv_ = 0, aGate_, gateOpen_ = 0;
};

/**
 * The output ceiling: a peak limiter with no lookahead, -1 dBFS. Ported
 * from OutLimiter in amp-worklet.js, including its fix — the envelope is
 * the max of the peak and its own decayed value, never decayed first.
 * Linked across channels, as the worklet is.
 */
class OutLimiter {
public:
    explicit OutLimiter(double sampleRate);
    /** In place, over `channels` channel pointers of `n` frames. */
    void process(float* const* ch, int channels, int n);
private:
    double env_ = 0, ceil_, rel_;
};

}  // namespace ampcore
