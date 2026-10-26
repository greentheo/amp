// MIDI learn and mapping, ported from js/midi.js.
//
// Any knob, fader, expression pedal or footswitch to any control: learn by
// arming a control and touching the hardware; absolute knobs with soft
// takeover, relative encoders, ranges for expression pedals, and footswitches
// that either toggle per press or follow a latching switch. The bindings are
// the browser's own "amp-midi-map" JSON, so a map exported from the browser
// loads here unchanged.
//
// It lives in the core rather than the page because the page is only a
// view. A WebView whose window is behind others gets suspended by macOS, and
// a footswitch has to work then too — and on iOS, in a plugin host, and on
// the platforms after those.
//
// Not thread-safe: the host serialises calls. Time is passed in rather than
// read, so the 600 ms footswitch detection is testable.

#pragma once
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "ampcore/json.hpp"

namespace ampcore {

struct MidiBinding {
    std::string id;           // the control: "amp.drive", "pedal.<uid>.on"
    std::string device;       // the input it was learned from; empty for any
    int ch = 0;               // 0..15
    std::string kind = "cc";  // "cc" | "note"
    int num = 0;
    std::string mode = "absolute";  // absolute | relative | toggle | follow
    double lo = 0, hi = 1;    // the slice of the control's range it sweeps
    bool takeover = true;

    // Soft-takeover state, not saved: has the hardware caught up with the
    // value yet, and where was it last.
    bool engaged = false;
    bool hasLast = false;
    double last = 0;
};

struct ControlInfo {
    enum Kind { None, Knob, Step, Switch };
    Kind kind = None;
    double min = 0, max = 1, step = 0;
};

/** The controls a map drives: the host's registry, as controls.js is the
 *  page's. Switches read and take 0 or 1. */
class ControlSurface {
public:
    virtual ~ControlSurface() = default;
    virtual ControlInfo info(const std::string& id) const = 0;
    virtual double value(const std::string& id) const = 0;
    virtual void set(const std::string& id, double value) = 0;
};

/** What the map has to say, for a UI. All optional. */
struct MidiEvents {
    std::function<void(const std::string& text, int count, const std::string& device)> activity;
    std::function<void(const std::string& id)> armed;  // empty when disarmed
    std::function<void(const MidiBinding& b, const std::vector<std::string>& alsoDrives)> learned;
    std::function<void(const std::string& id, const std::string& why)> refused;
    std::function<void()> bindingsChanged;
    std::function<void(const std::string& id, double n)> catching;  // n < 0 once caught
    std::function<void(const std::string& id, double value)> changed;
};

class MidiMap {
public:
    MidiMap(ControlSurface& surface, MidiEvents events = {});

    /** One message from `device`, at `now` seconds. */
    void onMessage(const uint8_t* data, int size, const std::string& device, double now);
    /** Resolve a footswitch's momentary-or-latching test once 600 ms pass. */
    void tick(double now);

    void arm(const std::string& id);
    void disarm();
    const std::string& armed() const { return armed_; }

    /** Something other than this map moved the control — the page, a
     *  preset — so every knob bound to it has to catch up again. */
    void touched(const std::string& id);

    /** The inputs connected now. A binding scoped to a device that is not
     *  among them acts as unscoped, since browsers and CoreMIDI do not
     *  always agree on a controller's name. */
    void setInputs(std::vector<std::string> names) { inputs_ = std::move(names); }

    const std::vector<MidiBinding>& bindings() const { return bindings_; }
    /** Replace them all — an edit in the UI, or an imported map. A binding
     *  that matches one already here keeps its takeover state. */
    void setBindings(std::vector<MidiBinding> next);
    void unbind(const std::string& id);
    int dropPrefix(const std::string& prefix);
    void clear();

    static std::vector<MidiBinding> fromJson(const Json& bindings);
    /** The bindings as a JSON array, in the browser's field order. */
    static std::string toJson(const std::vector<MidiBinding>& bindings);
    /** "CC 21 = 64  (ch1)": the activity monitor's line. */
    static std::string describe(int status, int ch, int a, int b);

private:
    void learn(const std::string& id, const std::string& kind, int num, int ch,
               const std::string& device, int value, double now);
    void apply(MidiBinding& b, int value);
    double norm(const std::string& id, const ControlInfo& c) const;
    void setNorm(const std::string& id, const ControlInfo& c, double n, const MidiBinding* by);
    void setControl(const std::string& id, const ControlInfo& c, double v, const MidiBinding* by);
    bool scoped(const MidiBinding& b, const std::string& device) const;
    void changed() { if (events_.bindingsChanged) events_.bindingsChanged(); }

    ControlSurface& surface_;
    MidiEvents events_;
    std::vector<MidiBinding> bindings_;
    std::vector<std::string> inputs_;
    std::string armed_;
    int count_ = 0;
    struct Detect { bool active = false; std::string id; int num = 0, ch = 0; bool released = false; double until = 0; } detect_;
};

}  // namespace ampcore
