#include "Editor.h"

// For the device manager and the audio settings dialog when running as the
// standalone app. In a plugin there is no holder, and getInstance() is null.
// The holder's header expects what JUCE's own standalone wrapper includes
// ahead of it.
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_audio_plugin_client/Standalone/juce_StandaloneFilterWindow.h>

namespace {

juce::File webRoot() {
    const auto dev = juce::SystemStats::getEnvironmentVariable("AMP_WEB_ROOT", {});
    if (dev.isNotEmpty()) return juce::File(dev);
    // Contents/MacOS/<binary> -> Contents/Resources/web, in an app bundle and
    // a plugin bundle alike.
    return juce::File::getSpecialLocation(juce::File::currentExecutableFile)
        .getParentDirectory().getParentDirectory().getChildFile("Resources/web");
}

juce::String mimeFor(const juce::File& f) {
    const auto ext = f.getFileExtension().toLowerCase();
    if (ext == ".html") return "text/html";
    if (ext == ".js" || ext == ".mjs") return "text/javascript";
    if (ext == ".css") return "text/css";
    if (ext == ".json") return "application/json";
    if (ext == ".webmanifest") return "application/manifest+json";
    if (ext == ".svg") return "image/svg+xml";
    if (ext == ".png") return "image/png";
    if (ext == ".wav") return "audio/wav";
    return "application/octet-stream";
}

juce::StandalonePluginHolder* holder() { return juce::StandalonePluginHolder::getInstance(); }

juce::var event(std::initializer_list<std::pair<const char*, juce::var>> fields) {
    auto* o = new juce::DynamicObject();
    for (const auto& f : fields) o->setProperty(f.first, f.second);
    return juce::var(o);
}

}  // namespace

AmpEditor::AmpEditor(AmpProcessor& p)
    : AudioProcessorEditor(p),
      proc_(p),
      root_(webRoot()),
      verbose_(juce::SystemStats::getEnvironmentVariable("AMP_LOG", {}).isNotEmpty()),
      // The saved settings go in with the page rather than as a reply to it.
      // A reply can lose a race: macOS suspends a WebView whose window is
      // behind others, and when it woke the page's fallback timer ran first
      // and it carried on with its own defaults.
      web_(juce::WebBrowserComponent::Options{}
               .withNativeIntegrationEnabled()
               .withKeepPageLoadedWhenBrowserIsHidden()
               .withInitialisationData("ampState", p.settings())
               .withInitialisationData("ampAudio", audioInfo())
               .withResourceProvider([this](const juce::String& path) { return serve(path); })
               .withEventListener("amp", [this](const juce::var& m) { handle(m); })) {
    addAndMakeVisible(web_);
    setResizable(true, true);
    setResizeLimits(720, 480, 4000, 3000);
    setSize(1200, 860);
    web_.goToURL(juce::WebBrowserComponent::getResourceProviderRoot());
    if (auto* h = holder()) h->deviceManager.addChangeListener(this);
    startTimerHz(30);
    log("editor open, serving " + root_.getFullPathName());
}

AmpEditor::~AmpEditor() {
    stopTimer();
    if (auto* h = holder()) h->deviceManager.removeChangeListener(this);
}

void AmpEditor::resized() { web_.setBounds(getLocalBounds()); }

std::optional<juce::WebBrowserComponent::Resource> AmpEditor::serve(const juce::String& path) const {
    auto rel = path.upToFirstOccurrenceOf("?", false, false).trimCharactersAtStart("/");
    if (rel.isEmpty()) rel = "index.html";
    const auto file = root_.getChildFile(rel);
    // Nothing outside the web root, whatever the path says.
    if (!file.isAChildOf(root_) || !file.existsAsFile()) {
        log("404 " + path);
        return std::nullopt;
    }
    juce::MemoryBlock bytes;
    if (!file.loadFileAsData(bytes)) return std::nullopt;
    if (verbose_) log("serve " + rel);
    const auto* b = static_cast<const std::byte*>(bytes.getData());
    return juce::WebBrowserComponent::Resource{std::vector<std::byte>(b, b + bytes.getSize()), mimeFor(file)};
}

void AmpEditor::handle(const juce::var& m) {
    const auto type = m["type"].toString();
    if (verbose_ && type != "log") log("page: " + juce::JSON::toString(m, true));

    if (type == "hello") {
        web_.emitEventIfBrowserIsVisible("state", event({{"settings", proc_.settings()}, {"audio", audioInfo()}}));
    } else if (type == "set") {
        proc_.setKnob(m["name"].toString(), m["value"]);
    } else if (type == "tone") {
        proc_.setTone(m);
    } else if (type == "cab") {
        proc_.setCab(m["opts"]);
    } else if (type == "board") {
        proc_.setBoard(m["board"]);
    } else if (type == "pedal") {
        proc_.setPedalValue(m["uid"].toString(), m["k"].toString(), m["v"]);
    } else if (type == "pedalOn") {
        proc_.setPedalOn(m["uid"].toString(), m["on"]);
    } else if (type == "voicing") {
        proc_.setVoicing(m["v"]);
    } else if (type == "panic") {
        proc_.panic();
    } else if (type == "audioSettings") {
        if (auto* h = holder()) h->showAudioSettingsDialog();
    } else if (type == "log") {
        log("page " + m["level"].toString() + ": " + m["text"].toString());
    }
}

juce::var AmpEditor::audioInfo() const {
    auto* h = holder();
    auto* d = h ? h->deviceManager.getCurrentAudioDevice() : nullptr;
    if (!d) return event({{"standalone", h != nullptr}});
    const auto setup = h->deviceManager.getAudioDeviceSetup();
    return event({
        {"standalone", true},
        {"input", setup.inputDeviceName},
        {"output", setup.outputDeviceName},
        {"rate", d->getCurrentSampleRate()},
        {"buffer", d->getCurrentBufferSizeSamples()},
        {"inLatency", d->getInputLatencyInSamples()},
        {"outLatency", d->getOutputLatencyInSamples()},
    });
}

void AmpEditor::timerCallback() {
    web_.emitEventIfBrowserIsVisible("meter", event({{"peak", static_cast<double>(proc_.takePeak())}}));
    // The device line too, now and then, in case a change landed while the
    // page was asleep.
    if (++ticks_ % 30 == 0) web_.emitEventIfBrowserIsVisible("audio", audioInfo());
}

void AmpEditor::changeListenerCallback(juce::ChangeBroadcaster*) {
    web_.emitEventIfBrowserIsVisible("audio", audioInfo());
}

void AmpEditor::log(const juce::String& line) const {
    const auto file = juce::File::getSpecialLocation(juce::File::userHomeDirectory).getChildFile("Library/Logs/Amp/amp.log");
    file.getParentDirectory().createDirectory();
    file.appendText(juce::Time::getCurrentTime().toString(false, true, true, true) + "  " + line + "\n");
}
