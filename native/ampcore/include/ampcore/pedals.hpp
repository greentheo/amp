// The eleven pedals, ported from js/audio/pedal-worklet.js.
//
// Same contract as the worklets: every knob is 0..1 and each pedal maps it
// to its own range, bypass is a 6 ms crossfade that settles into a straight
// copy, and the delay and the reverb ring out when they are switched off. The type ids are
// the board's ("overdrive", "delay", ...), so a saved board means the same
// pedals here as in the browser.
//
// The arithmetic follows the JS rounding for rounding — state in double,
// Float32Array storage as float — because the acceptance test is a null
// against the browser, not a listening test.

#pragma once
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace ampcore {

class Pedal {
public:
    virtual ~Pedal() = default;

    /** A pedal by its board type id; null for one this build does not have. */
    static std::unique_ptr<Pedal> create(const std::string& type, double rate);

    /** The eleven built-in type ids, in the order pedals.js registers them. */
    static const std::vector<std::string>& types();

    /** A knob (0..1), or "on" (0 or 1), held as float the way an AudioParam
     *  holds it. Unknown names are ignored, as buildPedals() ignores them. */
    void set(const std::string& name, double value);

    /** The same, arrived at over 12 ms rather than at once — a knob being
     *  turned, smoothed the way setTargetAtTime smooths it in the browser so
     *  a MIDI sweep does not zipper. Stepped once per process() call. */
    void glide(const std::string& name, double value);

    /**
     * One block. Knobs are read once per call, as a k-rate AudioParam is
     * read once per quantum, so call it in 128-frame blocks to match the
     * browser sample for sample. `in` may be null for silence, and may be
     * the same buffer as `out`.
     */
    void process(const float* in, float* out, int n);

protected:
    Pedal(double rate, std::vector<std::pair<std::string, float>> params);

    /** Knob i's value, in the order the constructor declared them; 0 is "on". */
    double knob(int i) const { return values_[static_cast<size_t>(i)]; }

    virtual void render(const float* x, float* y, int n, int on) = 0;
    /** True while a bypassed pedal still has something to say (delay tails). */
    virtual bool trails() const { return false; }
    /** Called once when a pedal settles into bypass, to clear its memory. */
    virtual void idle() {}

    /** Step the crossfade and mix a wet sample against the dry. */
    double blend(double dry, double wet, int on) {
        mix_ += (on - mix_) * aMix_;
        return dry + (wet - dry) * mix_;
    }

    const double rate_;
    double mix_ = 0;  // 0 bypassed .. 1 engaged

private:
    const double aMix_;
    bool idleDone_ = false;
    bool gliding_ = false;
    std::vector<std::string> names_;
    std::vector<float> values_, targets_;
};

}  // namespace ampcore
