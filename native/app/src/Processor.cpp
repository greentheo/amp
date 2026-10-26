#include "Processor.h"

#include <cstring>
#include <string>
#include <vector>

#include "Editor.h"

namespace {

// The browser's tone-stack select, in its order. std::string up front so
// switching stacks on the audio thread never has to build one.
const std::vector<std::string> STACKS = {"bassman", "twin", "jcm800", "jtm45", "ac30", "soldano"};

juce::AudioProcessorValueTreeState::ParameterLayout layout() {
    std::vector<std::unique_ptr<juce::RangedAudioParameter>> p;
    auto knob = [&](const char* id, const char* label, float lo, float hi, float def) {
        p.push_back(std::make_unique<juce::AudioParameterFloat>(
            juce::ParameterID{id, 1}, label, juce::NormalisableRange<float>(lo, hi), def));
    };
    // KNOBS in js/app.js, in panel order, with its defaults.
    knob("drive", "Gain", 0, 1, 0.55f);
    knob("bass", "Bass", 0, 1, 0.5f);
    knob("mid", "Mid", 0, 1, 0.5f);
    knob("treble", "Treble", 0, 1, 0.6f);
    knob("bias", "Bias", -0.5f, 0.5f, 0);
    knob("presence", "Presence", 0, 1, 0.3f);
    knob("sag", "Sag", 0, 1, 0.3f);
    knob("masterVol", "Volume", 0, 1, 0.5f);
    knob("gate", "Gate", 0, 1, 0);
    knob("reverb", "Reverb", 0, 1, 0.12f);
    knob("master", "Master", 0, 1, 0.8f);
    knob("cabMix", "Cab", 0, 1, 1);
    p.push_back(std::make_unique<juce::AudioParameterInt>(juce::ParameterID{"stages", 1}, "Stages", 1, 4, 3));
    juce::StringArray names;
    for (const auto& s : STACKS) names.add(s);
    p.push_back(std::make_unique<juce::AudioParameterChoice>(juce::ParameterID{"stack", 1}, "Stack", names, 2));
    return {std::make_move_iterator(p.begin()), std::make_move_iterator(p.end())};
}

const std::string& stackAt(float index) {
    const int i = juce::jlimit(0, static_cast<int>(STACKS.size()) - 1, static_cast<int>(index + 0.5f));
    return STACKS[static_cast<size_t>(i)];
}

juce::var object() { return juce::var(new juce::DynamicObject()); }

/** A JUCE value as ampcore's JSON, so the bridge's settings go through the
 *  same reader the null tests exercise. */
ampcore::Json toJson(const juce::var& v) {
    return ampcore::Json::parse(juce::JSON::toString(v, true).toStdString());
}

/** An object of up to three fields; an empty key is skipped. */
juce::var with3(const char* k1, const juce::var& v1, const char* k2, const juce::var& v2, const char* k3,
                const juce::var& v3) {
    auto o = juce::var(new juce::DynamicObject());
    auto* d = o.getDynamicObject();
    if (*k1) d->setProperty(k1, v1);
    if (*k2) d->setProperty(k2, v2);
    if (*k3) d->setProperty(k3, v3);
    return o;
}

/** {key: value} in one call. */
juce::var with(const char* key, const juce::var& value) {
    auto o = object();
    o.getDynamicObject()->setProperty(key, value);
    return o;
}

bool knownType(const juce::String& type) {
    for (const auto& t : ampcore::Pedal::types())
        if (type == juce::String(t)) return true;
    return false;
}

}  // namespace

AmpProcessor::AmpProcessor()
    : AudioProcessor(BusesProperties()
                         .withInput("Guitar", juce::AudioChannelSet::mono(), true)
                         .withOutput("Output", juce::AudioChannelSet::stereo(), true)),
      state(*this, nullptr, "Amp", layout()) {
    auto raw = [&](const char* id) { return state.getRawParameterValue(id); };
    drive_ = raw("drive");
    bass_ = raw("bass");
    mid_ = raw("mid");
    treble_ = raw("treble");
    bias_ = raw("bias");
    presence_ = raw("presence");
    sag_ = raw("sag");
    masterVol_ = raw("masterVol");
    gateKnob_ = raw("gate");
    reverb_ = raw("reverb");
    master_ = raw("master");
    cabMix_ = raw("cabMix");
    stages_ = raw("stages");
    stack_ = raw("stack");

    // The browser's defaults for the parts that are not knobs. The board
    // stays void until the page or a saved session supplies one, so a first
    // launch shows the browser's starting board rather than an empty one.
    cab_ = object();
    cab_.getDynamicObject()->setProperty("speaker", "v30");
    cab_.getDynamicObject()->setProperty("axis", 0.6);
    cab_.getDynamicObject()->setProperty("distance", 0.25);
    voicing_ = object();

    surface_ = std::make_unique<Surface>(*this);
    ampcore::MidiEvents ev;
    ev.activity = [this](const std::string& text, int count, const std::string& device) {
        post("activity", with3("text", juce::String(text), "count", count, "device", juce::String(device)));
    };
    ev.armed = [this](const std::string& id) { post("armed", juce::String(id)); };
    ev.learned = [this](const ampcore::MidiBinding& b, const std::vector<std::string>& also) {
        juce::Array<juce::var> ids;
        for (const auto& a : also) ids.add(juce::String(a));
        post("learned", with3("binding", juce::JSON::parse(ampcore::MidiMap::toJson({b}))[0], "also", ids, "", {}));
    };
    ev.refused = [this](const std::string& id, const std::string& why) {
        post("refused", with3("id", juce::String(id), "why", juce::String(why), "", {}));
    };
    ev.bindingsChanged = [this] { post("bindings", {}); };
    ev.catching = [this](const std::string& id, double n) {
        post("catching", with3("id", juce::String(id), "n", n, "", {}));
    };
    ev.changed = [this](const std::string& id, double v) {
        post("control", with3("id", juce::String(id), "value", v, "", {}));
    };
    midi_ = std::make_unique<ampcore::MidiMap>(*surface_, ev);

    // The standalone opens the hardware itself. In a plugin, MIDI will come
    // from the host instead.
    if (juce::JUCEApplicationBase::isStandaloneApp()) {
        midiRescan();
        deviceWatch_ = juce::MidiDeviceListConnection::make([this] { midiRescan(); });
        // `--midi-map <file>`: start with an exported map, for a rig that
        // should come up mapped. (A saved session's map loads after this.)
        const auto args = juce::StringArray::fromTokens(juce::JUCEApplicationBase::getCommandLineParameters(), true);
        const int at = args.indexOf("--midi-map");
        if (at >= 0 && at + 1 < args.size()) {
            const auto why = midiImport(juce::File(args[at + 1].unquoted()).loadFileAsString());
            if (why.isNotEmpty()) DBG("--midi-map: " << why);
        }
    }

    startTimerHz(20);
}

AmpProcessor::~AmpProcessor() {
    deviceWatch_ = {};
    inputs_.clear();  // no more callbacks into the map
    cancelPendingUpdate();
    stopTimer();
    delete nextCab_.exchange(nullptr);
    delete nextLanes_.exchange(nullptr);
    timerCallback();
}

// ---- settings ------------------------------------------------------------

juce::var AmpProcessor::settings() const {
    const auto midi = midiState();  // before settingsLock_: see the lock order
    std::lock_guard<std::mutex> lock(settingsLock_);
    auto knob = [&](std::atomic<float>* p) { return juce::var(static_cast<double>(p->load())); };
    auto root = object();
    auto* r = root.getDynamicObject();
    auto amp = object();
    auto* a = amp.getDynamicObject();
    a->setProperty("drive", knob(drive_));
    a->setProperty("bias", knob(bias_));
    a->setProperty("presence", knob(presence_));
    a->setProperty("sag", knob(sag_));
    a->setProperty("masterVol", knob(masterVol_));
    a->setProperty("gate", knob(gateKnob_));
    a->setProperty("stages", juce::roundToInt(stages_->load()));
    r->setProperty("amp", amp);
    auto tone = object();
    tone.getDynamicObject()->setProperty("stack", juce::String(stackAt(stack_->load())));
    tone.getDynamicObject()->setProperty("bass", knob(bass_));
    tone.getDynamicObject()->setProperty("mid", knob(mid_));
    tone.getDynamicObject()->setProperty("treble", knob(treble_));
    r->setProperty("tone", tone);
    r->setProperty("cabMix", knob(cabMix_));
    r->setProperty("reverb", knob(reverb_));
    r->setProperty("master", knob(master_));
    r->setProperty("cab", cab_.clone());
    r->setProperty("board", board_.clone());
    r->setProperty("voicing", voicing_.clone());
    r->setProperty("cabs", cabs_.isArray() ? cabs_.clone() : juce::var(juce::Array<juce::var>()));
    r->setProperty("midi", midi);
    return root;
}

ampcore::ChainSettings AmpProcessor::chainSettings() const {
    // settings() takes the lock itself, so build from the parts here.
    auto root = object();
    auto* r = root.getDynamicObject();
    auto amp = object();
    auto* a = amp.getDynamicObject();
    a->setProperty("drive", drive_->load());
    a->setProperty("bias", bias_->load());
    a->setProperty("presence", presence_->load());
    a->setProperty("sag", sag_->load());
    a->setProperty("masterVol", masterVol_->load());
    a->setProperty("gate", gateKnob_->load());
    a->setProperty("stages", stages_->load());
    r->setProperty("amp", amp);
    auto tone = object();
    tone.getDynamicObject()->setProperty("stack", juce::String(stackAt(stack_->load())));
    tone.getDynamicObject()->setProperty("bass", bass_->load());
    tone.getDynamicObject()->setProperty("mid", mid_->load());
    tone.getDynamicObject()->setProperty("treble", treble_->load());
    r->setProperty("tone", tone);
    r->setProperty("cabMix", cabMix_->load());
    r->setProperty("reverb", reverb_->load());
    r->setProperty("master", master_->load());
    r->setProperty("cab", cab_);
    r->setProperty("board", board_);
    r->setProperty("voicing", voicing_);
    return ampcore::ChainSettings::fromJson(toJson(root));
}

void AmpProcessor::setKnob(const juce::String& id, double value) {
    if (auto* p = state.getParameter(id)) p->setValueNotifyingHost(p->convertTo0to1(static_cast<float>(value)));
}

void AmpProcessor::setTone(const juce::var& tone) {
    if (tone.hasProperty("stack")) {
        const auto name = tone["stack"].toString().toStdString();
        for (size_t i = 0; i < STACKS.size(); i++)
            if (STACKS[i] == name) setKnob("stack", static_cast<double>(i));
    }
    for (const char* k : {"bass", "mid", "treble"})
        if (tone.hasProperty(k)) setKnob(k, tone[k]);
}

void AmpProcessor::setCab(const juce::var& opts) {
    std::lock_guard<std::mutex> lock(settingsLock_);
    if (auto* o = opts.getDynamicObject()) {
        auto next = cab_.clone();
        for (const auto& kv : o->getProperties()) {
            // A null clears an override rather than becoming one, as in setCab().
            if (kv.value.isVoid() || kv.value.isUndefined()) next.getDynamicObject()->removeProperty(kv.name);
            else next.getDynamicObject()->setProperty(kv.name, kv.value);
        }
        if (juce::JSON::toString(next, true) == juce::JSON::toString(cab_, true)) return;
        cab_ = next;
    }
    postCab();
}

void AmpProcessor::postCab() {
    const double rate = rate_.load();
    if (rate <= 0) return;  // prepareToPlay builds it
    const auto s = ampcore::ChainSettings::fromJson(toJson(with("cab", cab_)));
    delete nextCab_.exchange(ampcore::Chain::buildCab(rate, s.cab).release());
}

void AmpProcessor::setBoard(const juce::var& board) {
    std::lock_guard<std::mutex> lock(settingsLock_);
    board_ = board.clone();
    boardGen_++;
    postLanes();
}

void AmpProcessor::postLanes() {
    const double rate = rate_.load();
    if (rate <= 0 || !board_.isObject()) return;
    auto lanes = ampcore::Chain::buildLanes(rate, ampcore::ChainSettings::fromJson(toJson(with("board", board_))));
    lanes->generation = boardGen_;
    // A board that was waiting and never went in is simply replaced.
    delete nextLanes_.exchange(lanes.release());
}

bool AmpProcessor::findPedal(const juce::String& uid, int& lane, size_t& index, juce::var& slot) const {
    for (int l = 0; l < 2; l++) {
        const auto* list = board_[l == 0 ? "pre" : "post"].getArray();
        if (!list) continue;
        size_t built = 0;  // the chain only holds the pedals it could build
        for (const auto& p : *list) {
            const bool known = knownType(p["type"].toString());
            if (p["uid"].toString() == uid) {
                if (!known) return false;
                lane = l;
                index = built;
                slot = p;
                return true;
            }
            if (known) built++;
        }
    }
    return false;
}

void AmpProcessor::setPedalValue(const juce::String& uid, const juce::String& key, double value) {
    std::lock_guard<std::mutex> lock(settingsLock_);
    Command c;
    juce::var slot;
    if (!findPedal(uid, c.lane, c.index, slot) || key.length() >= static_cast<int>(sizeof c.name)) return;
    if (auto* values = slot["values"].getDynamicObject()) values->setProperty(key, value);
    c.gen = boardGen_;
    key.copyToUTF8(c.name, sizeof c.name);
    c.value = value;
    push(c);
}

void AmpProcessor::setPedalOn(const juce::String& uid, bool on) {
    std::lock_guard<std::mutex> lock(settingsLock_);
    Command c;
    juce::var slot;
    if (!findPedal(uid, c.lane, c.index, slot)) return;
    if (auto* o = slot.getDynamicObject()) o->setProperty("on", on);
    c.gen = boardGen_;
    std::strcpy(c.name, "on");
    c.value = on ? 1 : 0;
    push(c);
}

void AmpProcessor::setCabs(const juce::var& cabs) {
    std::lock_guard<std::mutex> lock(settingsLock_);
    cabs_ = cabs.isArray() ? cabs.clone() : juce::var();
}

void AmpProcessor::setVoicing(const juce::var& voicing) {
    std::lock_guard<std::mutex> lock(settingsLock_);
    voicing_ = voicing.isObject() ? voicing.clone() : object();
    Command c;
    c.isVoicing = true;
    c.voicing = ampcore::ChainSettings::fromJson(toJson(with("voicing", voicing_))).voicing;
    push(c);
}

// ---- threads ---------------------------------------------------------------

void AmpProcessor::push(const Command& c) {
    // Full means 256 knob turns the audio thread has not caught up with. The
    // value is in board_ regardless, so the next rebuild has it.
    const auto w = commandFifo_.write(1);
    if (w.blockSize1 > 0) commands_[static_cast<size_t>(w.startIndex1)] = c;
    else if (w.blockSize2 > 0) commands_[static_cast<size_t>(w.startIndex2)] = c;
}

void AmpProcessor::drainCommands() {
    int start1, size1, start2, size2;
    commandFifo_.prepareToRead(commandFifo_.getNumReady(), start1, size1, start2, size2);
    int done = 0;
    auto run = [&](int start, int size) {
        for (int i = 0; i < size; i++) {
            const Command& c = commands_[static_cast<size_t>(start + i)];
            // Aimed at a board that has not been swapped in yet: wait for it.
            if (!c.isVoicing && c.gen > lanesGen_) return false;
            if (c.isVoicing) chain_->setVoicing(c.voicing);
            else if (c.gen == lanesGen_) chain_->setPedal(c.lane, c.index, c.name, c.value);
            // Older than the board in the chain: already built into it.
            done++;
        }
        return true;
    };
    if (run(start1, size1)) run(start2, size2);
    commandFifo_.finishedRead(done);
}

void AmpProcessor::retire(Trash t) {
    // If the bin is ever full, leak rather than free on the audio thread.
    const auto w = trashFifo_.write(1);
    if (w.blockSize1 > 0) trash_[static_cast<size_t>(w.startIndex1)] = t;
    else if (w.blockSize2 > 0) trash_[static_cast<size_t>(w.startIndex2)] = t;
}

void AmpProcessor::timerCallback() {
    {
        std::lock_guard<std::mutex> lock(midiLock_);
        midi_->tick(juce::Time::getMillisecondCounterHiRes() / 1000);
    }
    juce::var cab;
    {
        std::lock_guard<std::mutex> lock(settingsLock_);
        std::swap(cab, pendingCab_);
    }
    if (cab.isObject()) setCab(cab);

    const auto r = trashFifo_.read(trashFifo_.getNumReady());
    auto empty = [&](int start, int size) {
        for (int i = 0; i < size; i++) {
            auto& t = trash_[static_cast<size_t>(start + i)];
            delete t.cab;
            delete t.lanes;
            t = {};
        }
    };
    empty(r.startIndex1, r.blockSize1);
    empty(r.startIndex2, r.blockSize2);
}

void AmpProcessor::takeHandoffs(int frames) {
    if (auto* cab = nextCab_.exchange(nullptr))
        retire({chain_->swapCab(std::unique_ptr<ampcore::Convolver>(cab)).release(), nullptr});

    if (panic_.exchange(false)) {
        heldFor_ = static_cast<int>(0.4 * rate_.load());
        if (duck_ != Duck::Closed) duck_ = Duck::Closing;
    }
    if (duck_ == Duck::Open && nextLanes_.load() != nullptr) duck_ = Duck::Closing;
    // A muting tuner holds it shut for as long as it is on.
    const bool hush = tuning_.load() && tunerMute_.load();
    if (hush && (duck_ == Duck::Open || duck_ == Duck::Opening)) duck_ = Duck::Closing;
    if (duck_ == Duck::Closed) {
        // Silent now, so the new pedals go in without a click.
        if (auto* lanes = nextLanes_.exchange(nullptr)) {
            lanesGen_ = lanes->generation;
            retire({nullptr, chain_->swapLanes(std::unique_ptr<ampcore::ChainLanes>(lanes)).release()});
        }
        if (heldFor_ > 0) heldFor_ -= frames;
        else if (nextLanes_.load() == nullptr && !hush) duck_ = Duck::Opening;
    }
}

void AmpProcessor::applyDuck(float* l, float* r, int n) {
    if (duck_ == Duck::Open) return;
    const double rate = rate_.load();
    const double down = 1 / (0.012 * rate), up = 1 / (0.02 * rate);
    for (int i = 0; i < n; i++) {
        if (duck_ == Duck::Closing && (duckGain_ -= down) <= 0) { duckGain_ = 0; duck_ = Duck::Closed; }
        else if (duck_ == Duck::Opening && (duckGain_ += up) >= 1) { duckGain_ = 1; duck_ = Duck::Open; }
        const auto g = static_cast<float>(duckGain_);
        l[i] *= g;
        if (r) r[i] *= g;
    }
}

void AmpProcessor::setTuner(bool on, bool mute) {
    tunerMute_.store(mute);
    // What is in the ring from last time is not the string being tuned now.
    if (on && !tuning_.load()) tunerFrom_.store(written_.load());
    tuning_.store(on);
}

bool AmpProcessor::tunerWindow(float* dst, int n) const {
    if (n <= 0 || n > RING / 2) return false;
    const uint64_t end = written_.load(std::memory_order_acquire);
    if (end < tunerFrom_.load() + static_cast<uint64_t>(n)) return false;
    const uint64_t from = end - static_cast<uint64_t>(n);
    for (int i = 0; i < n; i++) dst[i] = ring_[static_cast<size_t>((from + static_cast<uint64_t>(i)) % RING)];
    // Lapped while copying: the oldest of these may already be newer samples.
    return written_.load(std::memory_order_acquire) - from <= static_cast<uint64_t>(RING);
}

// ---- audio -----------------------------------------------------------------

void AmpProcessor::prepareToPlay(double sampleRate, int) {
    // Everything that allocates — impulse responses, convolvers, delay
    // lines — is built here or on the message thread, never in the callback.
    std::lock_guard<std::mutex> lock(settingsLock_);
    delete nextCab_.exchange(nullptr);
    delete nextLanes_.exchange(nullptr);
    chain_ = std::make_unique<ampcore::Chain>(sampleRate, chainSettings());
    lanesGen_ = boardGen_;
    duck_ = Duck::Open;
    duckGain_ = 1;
    rate_.store(sampleRate);
}

void AmpProcessor::releaseResources() {
    std::lock_guard<std::mutex> lock(settingsLock_);
    rate_.store(0);
    chain_.reset();
}

bool AmpProcessor::isBusesLayoutSupported(const BusesLayout& layouts) const {
    const auto mono = juce::AudioChannelSet::mono(), stereo = juce::AudioChannelSet::stereo();
    const auto in = layouts.getMainInputChannelSet(), out = layouts.getMainOutputChannelSet();
    return (in == mono || in == stereo) && (out == mono || out == stereo);
}

void AmpProcessor::pushParameters() {
    ampcore::AmpParams a;
    a.drive = drive_->load();
    a.bias = bias_->load();
    a.presence = presence_->load();
    a.sag = sag_->load();
    a.masterVol = masterVol_->load();
    a.gate = gateKnob_->load();
    a.stages = stages_->load();
    chain_->setAmp(a);
    chain_->setMix(cabMix_->load(), reverb_->load(), master_->load());
    chain_->setTone(stackAt(stack_->load()), treble_->load(), mid_->load(), bass_->load());
}

void AmpProcessor::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) {
    juce::ScopedNoDenormals noDenormals;
    const int n = buffer.getNumSamples();
    if (!chain_ || getTotalNumInputChannels() == 0 || getTotalNumOutputChannels() == 0) {
        buffer.clear();
        return;
    }
    takeHandoffs(n);
    drainCommands();
    pushParameters();

    // The guitar is the first input channel; a second one, if the device
    // has it, is ignored rather than summed in.
    const float* in = buffer.getReadPointer(0);
    if (tuning_.load(std::memory_order_relaxed)) {
        // Before the chain: the input and the left output can be one buffer.
        const uint64_t w = written_.load(std::memory_order_relaxed);
        for (int i = 0; i < n; i++) ring_[static_cast<size_t>((w + static_cast<uint64_t>(i)) % RING)] = in[i];
        written_.store(w + static_cast<uint64_t>(n), std::memory_order_release);
    }
    float* left = buffer.getWritePointer(0);
    float* right = nullptr;
    if (getTotalNumOutputChannels() >= 2) {
        right = buffer.getWritePointer(1);
        chain_->process(in, left, right, n);
        for (int c = 2; c < buffer.getNumChannels(); c++) buffer.clear(c, 0, n);
    } else {
        // One output channel takes the speaker down-mix, as the browser's
        // mono destination does, so both sides of the reverb arrive.
        float r[128];
        for (int at = 0; at < n; at += 128) {
            const int m = std::min(128, n - at);
            chain_->process(in + at, left + at, r, m);
            for (int i = 0; i < m; i++) left[at + i] = 0.5f * left[at + i] + 0.5f * r[i];
        }
    }
    applyDuck(left, right, n);

    float peak = 0;
    for (int i = 0; i < n; i++) peak = std::max(peak, std::fabs(left[i]));
    if (right) for (int i = 0; i < n; i++) peak = std::max(peak, std::fabs(right[i]));
    if (peak > peak_.load(std::memory_order_relaxed)) peak_.store(peak, std::memory_order_relaxed);
}

juce::AudioProcessorEditor* AmpProcessor::createEditor() { return new AmpEditor(*this); }

// ---- sessions --------------------------------------------------------------

void AmpProcessor::getStateInformation(juce::MemoryBlock& dest) {
    auto tree = state.copyState();
    const auto midi = midiState();
    {
        std::lock_guard<std::mutex> lock(settingsLock_);
        auto structure = object();
        structure.getDynamicObject()->setProperty("midi", midi["bindings"]);
        structure.getDynamicObject()->setProperty("cab", cab_);
        structure.getDynamicObject()->setProperty("board", board_);
        structure.getDynamicObject()->setProperty("voicing", voicing_);
        structure.getDynamicObject()->setProperty("cabs", cabs_);
        tree.setProperty("structure", juce::JSON::toString(structure, true), nullptr);
    }
    if (auto xml = tree.createXml()) copyXmlToBinary(*xml, dest);
}

void AmpProcessor::setStateInformation(const void* data, int size) {
    auto xml = getXmlFromBinary(data, size);
    if (!xml || !xml->hasTagName(state.state.getType())) return;
    auto tree = juce::ValueTree::fromXml(*xml);
    const auto structure = juce::JSON::parse(tree.getProperty("structure").toString());
    tree.removeProperty("structure", nullptr);
    state.replaceState(tree);
    if (!structure.isObject()) return;
    {
        // Replaced, not merged: a session is the whole of what it saved.
        std::lock_guard<std::mutex> lock(settingsLock_);
        if (structure["cab"].isObject()) cab_ = structure["cab"].clone();
        if (structure["cabs"].isArray()) cabs_ = structure["cabs"].clone();
        if (structure["board"].isObject()) {
            board_ = structure["board"].clone();
            boardGen_++;
        }
        postCab();
        postLanes();
    }
    setVoicing(structure["voicing"]);
    if (structure["midi"].isArray()) midiSetBindings(structure["midi"]);
}

// ---- MIDI ------------------------------------------------------------------

/** The controls the map drives, by the page's ids: "amp.<knob>",
 *  "amp.stages", "pedal.<uid>.<knob>", "pedal.<uid>.on", "tuner.on". */
class AmpProcessor::Surface : public ampcore::ControlSurface {
public:
    explicit Surface(AmpProcessor& p) : p_(p) {}

    ampcore::ControlInfo info(const std::string& id) const override {
        ampcore::ControlInfo c;
        const juce::String s(id);
        if (s.startsWith("amp.")) {
            const auto k = s.fromFirstOccurrenceOf("amp.", false, false);
            if (k == "stages") return {ampcore::ControlInfo::Step, 1, 4, 1};
            if (k == "axis" || k == "distance") return {ampcore::ControlInfo::Knob, 0, 1, 0};
            if (k == "stack") return c;
            if (auto* prm = p_.state.getParameter(k)) {
                const auto range = p_.state.getParameterRange(k);
                juce::ignoreUnused(prm);
                return {ampcore::ControlInfo::Knob, range.start, range.end, 0};
            }
            return c;
        }
        if (s == "tuner.on") return {ampcore::ControlInfo::Switch, 0, 1, 0};
        juce::String uid, key;
        juce::var slot;
        if (!pedal(s, uid, key, slot)) return c;
        if (key == "on") return {ampcore::ControlInfo::Switch, 0, 1, 0};
        if (slot["values"].hasProperty(key)) return {ampcore::ControlInfo::Knob, 0, 1, 0};
        return c;
    }

    double value(const std::string& id) const override {
        const juce::String s(id);
        if (s.startsWith("amp.")) {
            const auto k = s.fromFirstOccurrenceOf("amp.", false, false);
            if (k == "axis" || k == "distance") {
                std::lock_guard<std::mutex> lock(p_.settingsLock_);
                if (p_.pendingCab_.hasProperty(k)) return p_.pendingCab_[juce::Identifier(k)];
                return p_.cab_[juce::Identifier(k)];
            }
            auto* v = p_.state.getRawParameterValue(k);
            return v ? v->load() : 0;
        }
        if (s == "tuner.on") return p_.tuning() ? 1 : 0;
        juce::String uid, key;
        juce::var slot;
        if (!pedal(s, uid, key, slot)) return 0;
        if (key == "on") return static_cast<bool>(slot["on"]) ? 1 : 0;
        return slot["values"][juce::Identifier(key)];
    }

    void set(const std::string& id, double v) override {
        const juce::String s(id);
        if (s.startsWith("amp.")) {
            const auto k = s.fromFirstOccurrenceOf("amp.", false, false);
            if (k == "axis" || k == "distance") p_.queueCab(k, v);
            else p_.setKnob(k, v);
            return;
        }
        // A footswitch on the tuner works with the window shut: it mutes,
        // and the page opens the tuner when it wakes to the change.
        if (s == "tuner.on") return p_.setTuner(v >= 0.5, p_.tunerMute_.load());
        juce::String uid, key;
        juce::var slot;
        if (!pedal(s, uid, key, slot)) return;
        if (key == "on") p_.setPedalOn(uid, v >= 0.5);
        else p_.setPedalValue(uid, key, v);
    }

private:
    bool pedal(const juce::String& id, juce::String& uid, juce::String& key, juce::var& slot) const {
        if (!id.startsWith("pedal.")) return false;
        const auto rest = id.fromFirstOccurrenceOf("pedal.", false, false);
        uid = rest.upToLastOccurrenceOf(".", false, false);
        key = rest.fromLastOccurrenceOf(".", false, false);
        std::lock_guard<std::mutex> lock(p_.settingsLock_);
        int lane;
        size_t index;
        return p_.findPedal(uid, lane, index, slot);
    }

    AmpProcessor& p_;
};

void AmpProcessor::queueCab(const juce::String& key, double value) {
    // A MIDI knob on the cab sends a stream of values; rebuilding the cab
    // for each would be wasted work. The timer applies the latest.
    std::lock_guard<std::mutex> lock(settingsLock_);
    if (!pendingCab_.isObject()) pendingCab_ = object();
    pendingCab_.getDynamicObject()->setProperty(key, value);
}

void AmpProcessor::handleIncomingMidiMessage(juce::MidiInput* source, const juce::MidiMessage& m) {
    const auto* data = m.getRawData();
    const int size = m.getRawDataSize();
    // Clock, active sensing and sysex: nothing to bind, and clock alone
    // would flood the monitor.
    if (size < 1 || size > 3 || data[0] >= 0xf0) return;
    std::lock_guard<std::mutex> lock(midiLock_);
    midi_->onMessage(data, size, source->getName().toStdString(), juce::Time::getMillisecondCounterHiRes() / 1000);
}

void AmpProcessor::post(const char* kind, const juce::var& value) {
    {
        std::lock_guard<std::mutex> lock(outboxLock_);
        outbox_.add(with3("kind", juce::String(kind), "value", value, "", {}));
    }
    triggerAsyncUpdate();
}

void AmpProcessor::handleAsyncUpdate() {
    juce::Array<juce::var> items;
    {
        std::lock_guard<std::mutex> lock(outboxLock_);
        items.swapWith(outbox_);
    }
    if (!sink_ || items.isEmpty()) return;
    // A knob sweep is dozens of messages between two flushes. Send each
    // control's latest value once, and the monitor's latest line.
    juce::Array<juce::var> out, controls;
    juce::StringArray seen;
    bool bindings = false;
    juce::var activity;
    for (int i = items.size(); --i >= 0;) {
        const auto& it = items.getReference(i);
        const auto kind = it["kind"].toString();
        if (kind == "control") {
            const auto id = it["value"]["id"].toString();
            if (seen.contains(id)) continue;
            seen.add(id);
            controls.insert(0, it["value"]);
        } else if (kind == "activity") {
            if (activity.isVoid()) activity = it["value"];
        } else if (kind == "bindings") {
            bindings = true;
        }
    }
    for (const auto& it : items) {
        const auto kind = it["kind"].toString();
        if (kind != "control" && kind != "activity" && kind != "bindings") out.add(it);
    }
    if (!activity.isVoid()) out.add(with3("kind", "activity", "value", activity, "", {}));
    if (!controls.isEmpty()) out.add(with3("kind", "controls", "value", controls, "", {}));
    if (bindings) out.add(with3("kind", "bindings", "value", midiState()["bindings"], "", {}));
    sink_(out);
}

juce::var AmpProcessor::midiState() const {
    std::lock_guard<std::mutex> lock(midiLock_);
    juce::Array<juce::var> names;
    for (const auto& in : inputs_) names.add(in->getName());
    return with3("inputs", names, "bindings", juce::JSON::parse(ampcore::MidiMap::toJson(midi_->bindings())), "", {});
}

void AmpProcessor::midiRescan() {
    const auto available = juce::MidiInput::getAvailableDevices();
    std::vector<std::unique_ptr<juce::MidiInput>> keep;
    {
        std::lock_guard<std::mutex> lock(midiLock_);
        for (auto& in : inputs_) {
            bool present = false;
            for (const auto& d : available) present = present || d.identifier == in->getIdentifier();
            if (present) keep.push_back(std::move(in));
        }
    }
    // Closed outside the lock: stopping an input waits for its callback.
    std::vector<std::unique_ptr<juce::MidiInput>> gone;
    {
        std::lock_guard<std::mutex> lock(midiLock_);
        for (auto& in : inputs_) if (in) gone.push_back(std::move(in));
        inputs_ = std::move(keep);
    }
    gone.clear();
    std::vector<std::unique_ptr<juce::MidiInput>> opened;
    for (const auto& d : available) {
        bool open = false;
        {
            std::lock_guard<std::mutex> lock(midiLock_);
            for (const auto& in : inputs_) open = open || in->getIdentifier() == d.identifier;
        }
        if (open) continue;
        if (auto in = juce::MidiInput::openDevice(d.identifier, this)) {
            in->start();
            opened.push_back(std::move(in));
        }
    }
    std::vector<std::string> names;
    {
        std::lock_guard<std::mutex> lock(midiLock_);
        for (auto& in : opened) inputs_.push_back(std::move(in));
        for (const auto& in : inputs_) names.push_back(in->getName().toStdString());
        midi_->setInputs(names);
    }
    juce::Array<juce::var> list;
    for (const auto& n : names) list.add(juce::String(n));
    post("inputs", list);
}

void AmpProcessor::midiArm(const juce::String& id) {
    std::lock_guard<std::mutex> lock(midiLock_);
    midi_->arm(id.toStdString());
}

void AmpProcessor::midiDisarm() {
    std::lock_guard<std::mutex> lock(midiLock_);
    midi_->disarm();
}

void AmpProcessor::midiUnbind(const juce::String& id) {
    std::lock_guard<std::mutex> lock(midiLock_);
    midi_->unbind(id.toStdString());
}

int AmpProcessor::midiDrop(const juce::String& prefix) {
    std::lock_guard<std::mutex> lock(midiLock_);
    return midi_->dropPrefix(prefix.toStdString());
}

void AmpProcessor::midiClear() {
    std::lock_guard<std::mutex> lock(midiLock_);
    midi_->clear();
}

void AmpProcessor::midiTouched(const juce::String& id) {
    std::lock_guard<std::mutex> lock(midiLock_);
    midi_->touched(id.toStdString());
}

void AmpProcessor::midiSetBindings(const juce::var& list) {
    auto bindings = ampcore::MidiMap::fromJson(toJson(list));
    std::lock_guard<std::mutex> lock(midiLock_);
    midi_->setBindings(std::move(bindings));
}

juce::String AmpProcessor::midiImport(const juce::String& text) {
    const auto d = juce::JSON::parse(text);
    if (d["format"].toString() != "amp-midi-map") return "not an Amp MIDI map";
    midiSetBindings(d["bindings"]);
    return {};
}

juce::String AmpProcessor::midiExport() const {
    auto o = object();
    o.getDynamicObject()->setProperty("format", "amp-midi-map");
    o.getDynamicObject()->setProperty("version", 1);
    o.getDynamicObject()->setProperty("bindings", midiState()["bindings"]);
    return juce::JSON::toString(o);
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new AmpProcessor(); }
