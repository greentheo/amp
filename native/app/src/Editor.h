// The browser's own UI, in a WebView, talking to the processor.
//
// The page is the same index.html the browser build serves; what changes is
// the engine behind it. Seeing window.__JUCE__, the page uses NativeEngine
// (js/audio/native.js), which sends each knob turn, stomp and board change
// here as an "amp" event instead of driving Web Audio. The saved settings
// go in with the page as JUCE initialisation data; after that this side
// keeps a level meter and the device's latency coming back, and answers
// "hello" with the settings again for a page that has been reloaded.
//
// The files come from the app bundle's Resources/web, copied in at build
// time — or from AMP_WEB_ROOT, a checkout, so the page can be edited and
// reloaded without rebuilding the app.

#pragma once
#include <juce_gui_extra/juce_gui_extra.h>

#include <optional>

#include "Processor.h"

class AmpEditor : public juce::AudioProcessorEditor, private juce::Timer, private juce::ChangeListener {
public:
    explicit AmpEditor(AmpProcessor&);
    ~AmpEditor() override;

    void resized() override;

private:
    void timerCallback() override;
    void changeListenerCallback(juce::ChangeBroadcaster*) override;

    void handle(const juce::var& message);
    juce::var audioInfo() const;
    std::optional<juce::WebBrowserComponent::Resource> serve(const juce::String& path) const;
    void log(const juce::String& line) const;
    /** A line for the MIDI panel's status. */
    void note(const juce::String& text);

    AmpProcessor& proc_;
    const juce::File root_;
    const bool verbose_;
    int ticks_ = 0;
    juce::WebBrowserComponent web_;
    std::unique_ptr<juce::FileChooser> chooser_;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(AmpEditor)
};
