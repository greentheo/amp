// The spring reverb, ported from springIR() and the ConvolverNode it feeds
// in engine.js.
//
// The browser's reverb is a ConvolverNode left at normalize = true, so the
// level it plays at is set by Chromium's normalisation rule, not by the
// impulse response alone: scale to unit RMS power, then -58 dB, then by
// 44100 / rate. webAudioNormalizeScale() is that rule, in Chromium's float
// arithmetic (third_party/blink/renderer/platform/audio/reverb.cc).

#pragma once
#include <vector>

#include "ampcore/convolver.hpp"

namespace ampcore {

/** springIR() in engine.js: 1.4 s of seeded, decaying noise and a falling
 *  chirp, two channels drawn from one generator. */
std::vector<std::vector<float>> springIR(double rate);

/** The gain ConvolverNode applies to an impulse response when normalize is
 *  true. */
float webAudioNormalizeScale(const std::vector<std::vector<float>>& ir, double rate);

/** A mono-in, stereo-out convolution reverb: ConvolverNode's 1 -> 2 -> 2
 *  case, one convolver per channel of the response, both hearing the input. */
class Reverb {
public:
    Reverb(const std::vector<std::vector<float>>& ir, double rate, bool normalize, int partition = 128);
    void process(const float* in, float* outL, float* outR, int n);
    void reset();

private:
    Convolver left_, right_;
};

}  // namespace ampcore
