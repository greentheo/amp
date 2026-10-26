// The amp as a JUCE AudioProcessor: ampcore's Chain, with the browser's
// knobs as its parameters and the browser's own UI as its editor.
//
// Two kinds of setting. The amp's knobs, the tone stack and the bus gains
// are JUCE parameters — ids, labels and defaults from the browser's panel —
// so a host can automate them and they save with a session. The cab, the
// pedalboard and the voicing are structure rather than knobs, and are kept
// as the JSON the browser's engine.chainSettings() writes, so the two builds
// describe a sound the same way.
//
// Threads: the bridge calls in on the message thread. Anything that has to
// be rebuilt (a cab, a board) is built there and handed to the audio thread
// through an atomic pointer; knob turns on pedals go through a lock-free
// queue; what the audio thread lets go of is freed back on the message
// thread. The audio thread never allocates, frees or waits.

#pragma once
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_processors/juce_audio_processors.h>

#include <array>
#include <atomic>
#include <functional>
#include <memory>
#include <mutex>

#include "ampcore/chain.hpp"
#include "ampcore/midimap.hpp"

class AmpProcessor : public juce::AudioProcessor,
                     private juce::Timer,
                     private juce::AsyncUpdater,
                     private juce::MidiInputCallback {
public:
    AmpProcessor();
    ~AmpProcessor() override;

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

    // ---- the bridge, on the message thread ----------------------------

    /** Everything the chain renders with, in chainSettings() form, pedal
     *  uids included. `board` is void until a board has been set. */
    juce::var settings() const;
    void setKnob(const juce::String& id, double value);
    void setTone(const juce::var& tone);
    void setCab(const juce::var& opts);
    void setBoard(const juce::var& board);
    void setPedalValue(const juce::String& uid, const juce::String& key, double value);
    void setPedalOn(const juce::String& uid, bool on);
    /** The whole override set: {} or void is the stock voicing. */
    void setVoicing(const juce::var& voicing);
    void panic() { panic_.store(true); }
    /** The output's peak since the last call. */
    float takePeak() { return peak_.exchange(0.0f); }

    // ---- MIDI, on the message thread ----------------------------------
    //
    // The map is ampcore::MidiMap, a port of js/midi.js, running here rather
    // than in the page: MIDI arrives on CoreMIDI's thread and moves the
    // controls directly, so a footswitch works whether or not the WebView
    // is awake. The page only arms, edits and shows.

    void midiArm(const juce::String& id);
    void midiDisarm();
    void midiUnbind(const juce::String& id);
    int midiDrop(const juce::String& prefix);
    void midiClear();
    /** Replace the bindings: the page's table after an edit. */
    void midiSetBindings(const juce::var& list);
    /** An exported "amp-midi-map" file, in or out. */
    juce::String midiImport(const juce::String& text);  // empty on success, else why not
    juce::String midiExport() const;
    /** The page moved a control itself: knobs bound to it must catch up. */
    void midiTouched(const juce::String& id);
    void midiRescan();
    /** Where the map's news goes — the editor, while one is open. Called and
     *  delivered on the message thread. */
    void setMidiSink(std::function<void(const juce::var&)> sink) { sink_ = std::move(sink); }

private:
    struct Command {
        uint32_t gen = 0;  // the board generation a pedal command was aimed at
        bool isVoicing = false;
        int lane = 0;
        size_t index = 0;
        char name[24] = {};
        double value = 0;
        ampcore::Voicing voicing;
    };
    struct Trash {
        ampcore::Convolver* cab = nullptr;
        ampcore::ChainLanes* lanes = nullptr;
    };
    enum class Duck { Open, Closing, Closed, Opening };

    // These three expect settingsLock_ held.
    ampcore::ChainSettings chainSettings() const;
    void postCab();
    void postLanes();
    void pushParameters();
    void push(const Command& c);
    void drainCommands();
    void takeHandoffs(int frames);
    void applyDuck(float* l, float* r, int n);
    void retire(Trash t);
    bool findPedal(const juce::String& uid, int& lane, size_t& index, juce::var& slot) const;
    void timerCallback() override;

    class Surface;
    void handleIncomingMidiMessage(juce::MidiInput* source, const juce::MidiMessage& m) override;
    void handleAsyncUpdate() override;
    void post(const char* kind, const juce::var& value);  // any thread
    juce::var midiState() const;                            // takes midiLock_
    void queueCab(const juce::String& key, double value);

    std::unique_ptr<ampcore::Chain> chain_;
    std::atomic<double> rate_{0};

    // The structural settings, as JSON objects. The lock is for
    // prepareToPlay, which can run off the message thread; the audio
    // callback never takes it.
    mutable std::mutex settingsLock_;
    juce::var cab_, board_, voicing_;

    juce::AbstractFifo commandFifo_{256};
    std::array<Command, 256> commands_;
    juce::AbstractFifo trashFifo_{64};
    std::array<Trash, 64> trash_;
    std::atomic<ampcore::Convolver*> nextCab_{nullptr};
    std::atomic<ampcore::ChainLanes*> nextLanes_{nullptr};
    uint32_t boardGen_ = 0;  // message thread
    uint32_t lanesGen_ = 0;  // audio thread

    // The output ducks for a board rebuild as the browser's setBoard() does
    // (12 ms down, 20 back up), and holds shut for the panic button.
    Duck duck_ = Duck::Open;
    double duckGain_ = 1;
    int heldFor_ = 0;
    std::atomic<bool> panic_{false};
    std::atomic<float> peak_{0};

    // MIDI. Lock order: midiLock_ before settingsLock_, never the reverse.
    std::unique_ptr<Surface> surface_;
    std::unique_ptr<ampcore::MidiMap> midi_;
    mutable std::mutex midiLock_;
    std::vector<std::unique_ptr<juce::MidiInput>> inputs_;
    juce::MidiDeviceListConnection deviceWatch_;
    std::mutex outboxLock_;
    juce::Array<juce::var> outbox_;
    std::function<void(const juce::var&)> sink_;
    juce::var pendingCab_;  // knob moves on the cab, coalesced; settingsLock_

    std::atomic<float> *drive_, *bass_, *mid_, *treble_, *bias_, *presence_, *sag_;
    std::atomic<float> *masterVol_, *gateKnob_, *reverb_, *master_, *cabMix_, *stages_, *stack_;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(AmpProcessor)
};
