#include "Processor.h"

#include <string>
#include <vector>

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
    gate_ = raw("gate");
    reverb_ = raw("reverb");
    master_ = raw("master");
    cabMix_ = raw("cabMix");
    stages_ = raw("stages");
    stack_ = raw("stack");
}

ampcore::ChainSettings AmpProcessor::settingsNow() const {
    ampcore::ChainSettings s;
    s.amp.drive = drive_->load();
    s.amp.bias = bias_->load();
    s.amp.presence = presence_->load();
    s.amp.sag = sag_->load();
    s.amp.masterVol = masterVol_->load();
    s.amp.gate = gate_->load();
    s.amp.stages = stages_->load();
    s.stack = stackAt(stack_->load());
    s.treble = treble_->load();
    s.mid = mid_->load();
    s.bass = bass_->load();
    s.cabMix = cabMix_->load();
    s.reverb = reverb_->load();
    s.master = master_->load();
    return s;
}

void AmpProcessor::prepareToPlay(double sampleRate, int) {
    // Everything that allocates — the cab and reverb impulse responses, the
    // convolvers, the delay lines — happens here, off the audio thread.
    chain_ = std::make_unique<ampcore::Chain>(sampleRate, settingsNow());
}

void AmpProcessor::releaseResources() { chain_.reset(); }

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
    a.gate = gate_->load();
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
    pushParameters();

    // The guitar is the first input channel; a second one, if the device
    // has it, is ignored rather than summed in.
    const float* in = buffer.getReadPointer(0);
    if (getTotalNumOutputChannels() >= 2) {
        chain_->process(in, buffer.getWritePointer(0), buffer.getWritePointer(1), n);
        for (int c = 2; c < buffer.getNumChannels(); c++) buffer.clear(c, 0, n);
    } else {
        // One output channel takes the speaker down-mix, as the browser's
        // mono destination does, so both sides of the reverb arrive.
        float* out = buffer.getWritePointer(0);
        float right[128];
        for (int at = 0; at < n; at += 128) {
            const int m = std::min(128, n - at);
            chain_->process(in + at, out + at, right, m);
            for (int i = 0; i < m; i++) out[at + i] = 0.5f * out[at + i] + 0.5f * right[i];
        }
    }
}

juce::AudioProcessorEditor* AmpProcessor::createEditor() {
    return new juce::GenericAudioProcessorEditor(*this);
}

void AmpProcessor::getStateInformation(juce::MemoryBlock& dest) {
    if (auto xml = state.copyState().createXml()) copyXmlToBinary(*xml, dest);
}

void AmpProcessor::setStateInformation(const void* data, int size) {
    if (auto xml = getXmlFromBinary(data, size))
        if (xml->hasTagName(state.state.getType())) state.replaceState(juce::ValueTree::fromXml(*xml));
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new AmpProcessor(); }
