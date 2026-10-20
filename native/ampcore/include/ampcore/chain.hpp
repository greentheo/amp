// The whole signal path, as engine.js wires it:
//
//   in -> [pre pedals] -> amp -> cab x mix + dry x (1 - mix) -> [post pedals]
//      -> (itself + reverb send -> spring) x master -> limiter -> L, R
//
// Settings come in as the JSON the browser's engine.chainSettings() writes,
// so one file describes the same sound to both builds.

#pragma once
#include <memory>
#include <string>
#include <vector>

#include "ampcore/amp.hpp"
#include "ampcore/cab.hpp"
#include "ampcore/convolver.hpp"
#include "ampcore/json.hpp"
#include "ampcore/pedals.hpp"
#include "ampcore/reverb.hpp"

namespace ampcore {

struct BoardSlot {
    std::string type;
    bool on = false;
    std::vector<std::pair<std::string, double>> values;
};

struct ChainSettings {
    AmpParams amp;  // as asked for; rounded to float on the way in, as AudioParams round
    std::string stack = "jcm800";
    double treble = 0.6, mid = 0.5, bass = 0.5;
    Voicing voicing;
    CabOpts cab;
    double cabMix = 1, reverb = 0.12, master = 0.8;
    std::vector<BoardSlot> pre, post;

    /** From engine.chainSettings()'s JSON. Absent fields keep the defaults. */
    static ChainSettings fromJson(const Json& j);
};

class Chain {
public:
    Chain(double rate, const ChainSettings& s);

    /**
     * Mono in, stereo out, any block length; `in` may be `outL`. Blocks are
     * cut into pieces of at most 128 frames, and the amp and the pedals read
     * their knobs once per piece, as k-rate AudioParams are read once per
     * quantum. With the knobs held still the block size makes no difference;
     * 128-frame calls also match the browser while they move.
     */
    void process(const float* in, float* outL, float* outR, int n);

    /**
     * Live changes, the way engine.set() makes them in the browser: each
     * value glides to its target with the time constant engine.js gives it
     * (20 ms on the amp's knobs, 30 on master and cab mix, 50 on the reverb
     * send), stepped once per block. Call from the audio thread, between
     * process() calls. A render that never calls them is untouched by them.
     */
    void setAmp(const AmpParams& target);
    void setMix(double cabMix, double reverb, double master);
    /** The tone stack switches at once, as a posted coefficient set does. */
    void setTone(const std::string& stack, double treble, double mid, double bass);

private:
    static constexpr int MAX_BLOCK = 128;

    void glide(int frames);

    const double rate_;
    AmpParams params_, ampTo_;
    double mix_, mixTo_, sendNow_, sendTo_, masterNow_, masterTo_;
    bool gliding_ = false;
    std::string stack_;
    double treble_, mid_, bass_;
    Amp amp_;
    Convolver cab_;
    Reverb verb_;
    OutLimiter limiter_;
    std::vector<std::unique_ptr<Pedal>> pre_, post_;
    float wet_, dry_, send_, master_;  // GainNodes hold float
    float a_[MAX_BLOCK], b_[MAX_BLOCK], c_[MAX_BLOCK], vl_[MAX_BLOCK], vr_[MAX_BLOCK];
};

}  // namespace ampcore
