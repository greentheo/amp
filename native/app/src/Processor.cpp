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
    knob("gate", "Gate", 0, 1, 0.12f);
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

    startTimerHz(10);
}

AmpProcessor::~AmpProcessor() {
    stopTimer();
    delete nextCab_.exchange(nullptr);
    delete nextLanes_.exchange(nullptr);
    timerCallback();
}

// ---- settings ------------------------------------------------------------

juce::var AmpProcessor::settings() const {
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
    if (duck_ == Duck::Closed) {
        // Silent now, so the new pedals go in without a click.
        if (auto* lanes = nextLanes_.exchange(nullptr)) {
            lanesGen_ = lanes->generation;
            retire({nullptr, chain_->swapLanes(std::unique_ptr<ampcore::ChainLanes>(lanes)).release()});
        }
        if (heldFor_ > 0) heldFor_ -= frames;
        else if (nextLanes_.load() == nullptr) duck_ = Duck::Opening;
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
    {
        std::lock_guard<std::mutex> lock(settingsLock_);
        auto structure = object();
        structure.getDynamicObject()->setProperty("cab", cab_);
        structure.getDynamicObject()->setProperty("board", board_);
        structure.getDynamicObject()->setProperty("voicing", voicing_);
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
        if (structure["board"].isObject()) {
            board_ = structure["board"].clone();
            boardGen_++;
        }
        postCab();
        postLanes();
    }
    setVoicing(structure["voicing"]);
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new AmpProcessor(); }
