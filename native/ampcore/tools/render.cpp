// ampcore-render: run a WAV through the native amp.
//
//   ampcore-render in.wav out.wav --chain settings.json
//   ampcore-render in.wav out.wav --drive 0.55 --stages 3 --stack jcm800 ...
//   ampcore-render --dump-tone jcm800 0.6 0.5 0.5 192000
//
// --chain renders the whole path — pedals, amp, cab, reverb, limiter — from
// the settings the browser's engine.chainSettings() writes, and mixes it to
// mono the way an OfflineAudioContext with one channel does, so it lines up
// with renderStimulus() sample for sample. Without it, the amp alone: what
// the browser's amp-processor worklet is.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <map>
#include <string>

#include "ampcore/amp.hpp"
#include "ampcore/chain.hpp"
#include "ampcore/tonestack.hpp"
#include "ampcore/wav.hpp"

using namespace ampcore;

/** Every Web Audio AudioParam holds a 32-bit float, so the browser's amp
 *  never sees 0.55 — it sees 0.550000011920929. Round the same way, or the
 *  two builds start from different numbers. */
static double asParam(double v) { return static_cast<double>(static_cast<float>(v)); }

int main(int argc, char** argv) {
    if (argc >= 2 && !std::strcmp(argv[1], "--dump-tone")) {
        if (argc < 7) { std::fprintf(stderr, "usage: --dump-tone stack treble mid bass rate\n"); return 2; }
        const ToneCoeffs k = coeffs(argv[2], std::atof(argv[3]), std::atof(argv[4]), std::atof(argv[5]), std::atof(argv[6]));
        std::printf("{\"g\":%.17g,\"al0\":%.17g,\"al1\":%.17g,\"be1\":%.17g,\"be2\":%.17g,\"be3\":%.17g,\"dn\":%.17g,\"nx\":%.17g}\n",
                    k.g, k.al0, k.al1, k.be1, k.be2, k.be3, k.dn, k.nx);
        return 0;
    }
    if (argc < 3) {
        std::fprintf(stderr,
            "usage: ampcore-render in.wav out.wav --chain settings.json [--block n]\n"
            "       ampcore-render in.wav out.wav [--drive x] [--bias x] [--presence x] [--sag x]\n"
            "       [--master-vol x] [--gate x] [--stages n] [--stack id] [--bass x] [--mid x]\n"
            "       [--treble x] [--no-tone] [--tail seconds]\n");
        return 2;
    }
    const std::string inPath = argv[1], outPath = argv[2];
    std::map<std::string, std::string> o;
    bool noTone = false;
    for (int i = 3; i < argc; i++) {
        std::string a = argv[i];
        if (a == "--no-tone") { noTone = true; continue; }
        if (a.rfind("--", 0) == 0 && i + 1 < argc) o[a.substr(2)] = argv[++i];
    }
    auto num = [&](const char* k, double d) { return o.count(k) ? std::atof(o[k].c_str()) : d; };

    Wav in = readWav(inPath);

    if (o.count("chain")) {
        std::ifstream f(o["chain"]);
        if (!f) { std::fprintf(stderr, "cannot open %s\n", o["chain"].c_str()); return 1; }
        std::stringstream text;
        text << f.rdbuf();
        Chain chain(in.rate, ChainSettings::fromJson(Json::parse(text.str())));
        std::vector<float> x(in.mono);
        x.resize(x.size() + static_cast<size_t>(num("tail", 2.0) * in.rate + 0.5), 0.0f);
        std::vector<float> y(x.size());
        // --block is the host's block size, as a device or a DAW would pick
        // it. With settings held still it should make no difference at all.
        const size_t block = static_cast<size_t>(num("block", 128));
        std::vector<float> l(block), r(block);
        for (size_t at = 0; at < x.size(); at += block) {
            const int n = static_cast<int>(std::min(block, x.size() - at));
            chain.process(&x[at], l.data(), r.data(), n);
            // Stereo into a one-channel destination: Chromium's speaker
            // down-mix, 0.5 * L summed with 0.5 * R.
            for (int i = 0; i < n; i++) y[at + i] = 0.5f * l[i] + 0.5f * r[i];
        }
        writeWavFloat(outPath, y, in.rate);
        std::printf("%s  %zu frames @ %.0f Hz, full chain\n", outPath.c_str(), y.size(), in.rate);
        return 0;
    }

    AmpParams p;
    p.drive = asParam(num("drive", 0.55));
    p.bias = asParam(num("bias", 0));
    p.presence = asParam(num("presence", 0.3));
    p.sag = asParam(num("sag", 0.3));
    p.masterVol = asParam(num("master-vol", 0.5));
    p.gate = asParam(num("gate", 0.12));
    p.stages = asParam(num("stages", 3));

    Amp amp(in.rate);
    if (!noTone) {
        const std::string stack = o.count("stack") ? o["stack"] : "jcm800";
        amp.setTone(coeffs(stack, num("treble", 0.6), num("mid", 0.5), num("bass", 0.5), in.rate * Amp::OS));
    }

    // The same tail the browser's renderStimulus adds, so the files line up.
    const size_t tail = static_cast<size_t>(num("tail", 2.0) * in.rate + 0.5);
    std::vector<float> x(in.mono);
    x.resize(x.size() + tail, 0.0f);
    std::vector<float> y(x.size());
    // 128-frame quanta, as the worklet sees them. With constant parameters it
    // makes no difference, but it costs nothing to match.
    for (size_t at = 0; at < x.size(); at += 128) {
        const int n = static_cast<int>(std::min<size_t>(128, x.size() - at));
        amp.process(&x[at], &y[at], n, p);
    }
    writeWavFloat(outPath, y, in.rate);
    std::printf("%s  %zu frames @ %.0f Hz\n", outPath.c_str(), y.size(), in.rate);
    return 0;
}
