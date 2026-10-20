// The amp as a JUCE AudioProcessor: ampcore's Chain, with the browser's
// knobs as its parameters.
//
// The parameter ids are the browser's knob keys (drive, masterVol, cabMix…)
// and the labels are the ones on its panel, so a saved setting and a MIDI
// map mean the same knob in both. For now the editor is JUCE's generic one;
// the browser's own UI arrives in a WebView next, over a bridge that carries
// parameters, not audio.

#pragma once
#include <juce_audio_processors/juce_audio_processors.h>

#include <atomic>
#include <memory>

#include "ampcore/chain.hpp"

class AmpProcessor : public juce::AudioProcessor {
public:
    AmpProcessor();

    void prepareToPlay(double sampleRate, int maximumBlockSize) override;
    void releaseResources() override;
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    using AudioProcessor::processBlock;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return JucePlugin_Name; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    // The spring rings for 1.4 s; the delay's repeats can outlast it.
    double getTailLengthSeconds() const override { return 2.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    void getStateInformation(juce::MemoryBlock& dest) override;
    void setStateInformation(const void* data, int size) override;

    juce::AudioProcessorValueTreeState state;

private:
    ampcore::ChainSettings settingsNow() const;
    void pushParameters();

    std::unique_ptr<ampcore::Chain> chain_;

    std::atomic<float> *drive_, *bass_, *mid_, *treble_, *bias_, *presence_, *sag_;
    std::atomic<float> *masterVol_, *gate_, *reverb_, *master_, *cabMix_, *stages_, *stack_;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(AmpProcessor)
};
