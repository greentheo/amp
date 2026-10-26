#include "ampcore/midimap.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace ampcore {

namespace {

const char* const NOTES[] = {"C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"};

std::string noteName(int n) { return std::string(NOTES[n % 12]) + std::to_string(n / 12 - 1); }

std::string quoted(const std::string& s) {
    std::string out = "\"";
    for (unsigned char c : s) {
        if (c == '"' || c == '\\') { out += '\\'; out += static_cast<char>(c); }
        else if (c < 0x20) { char u[8]; std::snprintf(u, sizeof u, "\\u%04x", c); out += u; }
        else out += static_cast<char>(c);
    }
    return out + "\"";
}

std::string number(double v) {
    char buf[32];
    std::snprintf(buf, sizeof buf, "%.17g", v);
    // The shortest form that reads back the same, as JSON.stringify writes it.
    for (int p = 1; p <= 17; p++) {
        char t[32];
        std::snprintf(t, sizeof t, "%.*g", p, v);
        if (std::strtod(t, nullptr) == v) return t;
    }
    return buf;
}

bool sameSource(const MidiBinding& a, const MidiBinding& b) {
    return a.id == b.id && a.kind == b.kind && a.num == b.num && a.ch == b.ch && a.device == b.device;
}

}  // namespace

MidiMap::MidiMap(ControlSurface& surface, MidiEvents events) : surface_(surface), events_(std::move(events)) {}

std::string MidiMap::describe(int status, int ch, int a, int b) {
    const std::string c = "ch" + std::to_string(ch + 1);
    if (status == 0xb0) return "CC " + std::to_string(a) + " = " + std::to_string(b) + "  (" + c + ")";
    if (status == 0x90 && b > 0)
        return "note on " + noteName(a) + " (" + std::to_string(a) + ") vel " + std::to_string(b) + "  (" + c + ")";
    if (status == 0x80 || status == 0x90) return "note off " + noteName(a) + " (" + std::to_string(a) + ")  (" + c + ")";
    if (status == 0xc0) return "program change " + std::to_string(a) + "  (" + c + ")";
    if (status == 0xe0) return "pitch bend  (" + c + ")";
    char hex[8];
    std::snprintf(hex, sizeof hex, "%x", status);
    return "status 0x" + std::string(hex) + " " + std::to_string(a) + " " + std::to_string(b) + "  (" + c + ")";
}

void MidiMap::arm(const std::string& id) {
    armed_ = id;
    if (events_.armed) events_.armed(id);
}

void MidiMap::disarm() {
    armed_.clear();
    if (events_.armed) events_.armed({});
}

void MidiMap::touched(const std::string& id) {
    for (auto& b : bindings_)
        if (b.id == id) b.engaged = false;
}

bool MidiMap::scoped(const MidiBinding& b, const std::string& device) const {
    if (b.device.empty() || device.empty() || b.device == device) return true;
    // Learned on a device that is not here at all: likely the same
    // controller under another name, so do not let the name lock it out.
    return std::find(inputs_.begin(), inputs_.end(), b.device) == inputs_.end();
}

void MidiMap::onMessage(const uint8_t* data, int size, const std::string& device, double now) {
    if (size < 1) return;
    tick(now);
    const int status = data[0] & 0xf0, ch = data[0] & 0x0f;
    const int a = size > 1 ? data[1] : 0, v = size > 2 ? data[2] : 0;
    count_++;
    if (events_.activity) events_.activity(describe(status, ch, a, v), count_, device);

    std::string kind;
    int value;
    if (status == 0xb0) { kind = "cc"; value = v; }
    else if (status == 0x90 && v > 0) { kind = "note"; value = 127; }
    else if (status == 0x80 || status == 0x90) { kind = "note"; value = 0; }
    else return;  // program change and the rest: not bound yet

    if (detect_.active && kind == "cc" && detect_.num == a && detect_.ch == ch && value < 64) detect_.released = true;

    if (!armed_.empty()) {
        // A note-off is the tail of the press just learned, not a new control.
        if (kind == "note" && value == 0) return;
        return learn(armed_, kind, a, ch, device, value, now);
    }

    for (auto& b : bindings_) {
        if (b.kind != kind || b.num != a || b.ch != ch) continue;
        if (!scoped(b, device)) continue;
        apply(b, value);
    }
}

void MidiMap::tick(double now) {
    if (!detect_.active || now < detect_.until) return;
    // A release within 600 ms means a momentary switch: toggle per press.
    // None means a latching one: follow it.
    for (auto& b : bindings_)
        if (b.id == detect_.id && b.kind == "cc" && b.num == detect_.num && b.ch == detect_.ch)
            b.mode = detect_.released ? "toggle" : "follow";
    detect_.active = false;
    changed();
}

void MidiMap::learn(const std::string& id, const std::string& kind, int num, int ch,
                    const std::string& device, int value, double now) {
    const ControlInfo c = surface_.info(id);
    if (c.kind == ControlInfo::None) { disarm(); return; }
    const bool isSwitch = c.kind == ControlInfo::Switch;

    if (!isSwitch && kind == "note") {
        if (events_.refused)
            events_.refused(id, "That was a note. A knob needs a knob, fader or expression pedal — "
                                "move one, or arm a footswitch target instead.");
        return;
    }

    // One source per control: learning again replaces it. One physical
    // control may still drive several targets, which is reported, not stolen.
    bindings_.erase(std::remove_if(bindings_.begin(), bindings_.end(),
                                   [&](const MidiBinding& b) { return b.id == id; }),
                    bindings_.end());
    MidiBinding b;
    b.id = id;
    b.device = device;
    b.ch = ch;
    b.kind = kind;
    b.num = num;
    b.mode = isSwitch ? "toggle" : "absolute";
    b.engaged = true;
    b.hasLast = true;
    b.last = value / 127.0;

    std::vector<std::string> also;
    for (const auto& o : bindings_)
        if (o.kind == kind && o.num == num && o.ch == ch && (o.device.empty() || device.empty() || o.device == device))
            also.push_back(o.id);
    bindings_.push_back(b);

    if (isSwitch && kind == "cc") detect_ = {true, id, num, ch, false, now + 0.6};

    armed_.clear();
    if (events_.learned) events_.learned(b, also);
    changed();
}

double MidiMap::norm(const std::string& id, const ControlInfo& c) const {
    const double v = surface_.value(id);
    if (c.kind == ControlInfo::Switch) return v >= 0.5 ? 1 : 0;
    const double span = c.max - c.min;
    return (v - c.min) / (span != 0 ? span : 1);
}

void MidiMap::setControl(const std::string& id, const ControlInfo& c, double v, const MidiBinding* by) {
    double x;
    if (c.kind == ControlInfo::Switch) {
        x = v >= 0.5 ? 1 : 0;
        if (x == (surface_.value(id) >= 0.5 ? 1 : 0)) return;
    } else {
        x = std::min(c.max, std::max(c.min, v));
        if (c.kind == ControlInfo::Step || c.step > 0) {
            const double st = c.step > 0 ? c.step : 1;
            x = c.min + std::round((x - c.min) / st) * st;
        }
        if (x == surface_.value(id)) return;
    }
    surface_.set(id, x);
    if (events_.changed) events_.changed(id, x);
    // Moved by this binding: every other knob on the same control has to
    // catch up before it may drive it.
    for (auto& o : bindings_)
        if (o.id == id && &o != by) o.engaged = false;
}

void MidiMap::setNorm(const std::string& id, const ControlInfo& c, double n, const MidiBinding* by) {
    if (c.kind == ControlInfo::Switch) return setControl(id, c, n >= 0.5 ? 1 : 0, by);
    setControl(id, c, c.min + std::min(1.0, std::max(0.0, n)) * (c.max - c.min), by);
}

void MidiMap::apply(MidiBinding& b, int value) {
    const ControlInfo c = surface_.info(b.id);
    if (c.kind == ControlInfo::None) return;

    if (c.kind == ControlInfo::Switch) {
        const bool down = value >= 64;
        if (b.mode == "follow") {
            setControl(b.id, c, down ? 1 : 0, &b);
        } else if (down && !(b.hasLast && b.last >= 0.5)) {
            // Toggle on the press only; a momentary switch's release would
            // switch it straight back.
            setControl(b.id, c, surface_.value(b.id) >= 0.5 ? 0 : 1, &b);
        }
        b.last = value / 127.0;
        b.hasLast = true;
        return;
    }

    if (b.mode == "relative") {
        // Two's complement, the common encoding: 1..63 up, 127..65 down.
        const int delta = value < 64 ? value : value - 128;
        setNorm(b.id, c, norm(b.id, c) + delta / 127.0, &b);
        return;
    }

    // Absolute, into this binding's slice of the range.
    const double n = b.lo + (value / 127.0) * (b.hi - b.lo);
    if (b.takeover && !b.engaged) {
        const double cur = norm(b.id, c);
        const bool crossed = b.hasLast && (b.last - cur) * (n - cur) <= 0;
        if (crossed || std::fabs(n - cur) < 0.03) b.engaged = true;
        b.last = n;
        b.hasLast = true;
        if (events_.catching) events_.catching(b.id, b.engaged ? -1 : n);
        if (!b.engaged) return;
    }
    b.last = n;
    b.hasLast = true;
    b.engaged = true;
    setNorm(b.id, c, n, &b);
}

void MidiMap::setBindings(std::vector<MidiBinding> next) {
    for (auto& b : next) {
        b.engaged = false;
        b.hasLast = false;
        for (const auto& o : bindings_)
            if (sameSource(o, b)) { b.engaged = o.engaged; b.hasLast = o.hasLast; b.last = o.last; }
    }
    bindings_ = std::move(next);
    changed();
}

void MidiMap::unbind(const std::string& id) {
    bindings_.erase(std::remove_if(bindings_.begin(), bindings_.end(),
                                   [&](const MidiBinding& b) { return b.id == id; }),
                    bindings_.end());
    changed();
}

int MidiMap::dropPrefix(const std::string& prefix) {
    const size_t before = bindings_.size();
    bindings_.erase(std::remove_if(bindings_.begin(), bindings_.end(),
                                   [&](const MidiBinding& b) { return b.id.rfind(prefix, 0) == 0; }),
                    bindings_.end());
    if (bindings_.size() != before) changed();
    return static_cast<int>(before - bindings_.size());
}

void MidiMap::clear() {
    bindings_.clear();
    changed();
}

std::vector<MidiBinding> MidiMap::fromJson(const Json& arr) {
    std::vector<MidiBinding> out;
    if (arr.type != Json::Array) return out;
    for (const Json& j : arr.a) {
        // As midi.js's load(): anything without an id and a kind is dropped.
        const std::string id = j.str("id", ""), kind = j.str("kind", "");
        if (id.empty() || kind.empty()) continue;
        MidiBinding b;
        b.id = id;
        b.kind = kind;
        b.device = j.str("device", "");
        b.ch = static_cast<int>(j.num("ch", 0));
        b.num = static_cast<int>(j.num("num", 0));
        b.mode = j.str("mode", b.mode);
        b.lo = j.num("lo", 0);
        b.hi = j.num("hi", 1);
        const Json* t = j.get("takeover");
        b.takeover = !t || t->type != Json::Bool || t->b;
        out.push_back(std::move(b));
    }
    return out;
}

std::string MidiMap::toJson(const std::vector<MidiBinding>& bindings) {
    std::string s = "[";
    for (size_t i = 0; i < bindings.size(); i++) {
        const auto& b = bindings[i];
        if (i) s += ",";
        s += "{\"id\":" + quoted(b.id) + ",\"device\":" + quoted(b.device) + ",\"ch\":" + std::to_string(b.ch)
            + ",\"kind\":" + quoted(b.kind) + ",\"num\":" + std::to_string(b.num) + ",\"mode\":" + quoted(b.mode)
            + ",\"lo\":" + number(b.lo) + ",\"hi\":" + number(b.hi) + ",\"takeover\":" + (b.takeover ? "true" : "false")
            + "}";
    }
    return s + "]";
}

}  // namespace ampcore
