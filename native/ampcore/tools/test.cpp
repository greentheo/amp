// ampcore-test: pieces of the chain on their own, for null tests against
// the browser build.
//
//   ampcore-test biquad <lowpass|highpass|peaking|lowshelf> hz q db in.wav out.wav [--float-state]
//   ampcore-test cab out.wav <speaker> [key=value ...]
//   ampcore-test spring outL.wav outR.wav
//   ampcore-test conv cab in.wav out.wav <speaker> [key=value ...]
//   ampcore-test conv ir ir.wav in.wav out.wav
//   ampcore-test conv spring in.wav outL.wav outR.wav
//   ampcore-test pedal <type> in.wav out.wav [knob=value ...] [--toggle s1,s2,...]
//
// Everything renders at 48 kHz, the stimulus's rate. The conv commands add
// the same 2 s tail renderStimulus() does, and take --partition N (the
// convolver's block, default 128) and --block N (the host's, default 128):
// the output should not depend on either.
//
// The pedal command starts with the pedal on (unless on=0 is given) and
// flips the footswitch at each --toggle time, in seconds, which should be
// whole render quanta (any whole second at 48 kHz is). It runs in 128-frame
// quanta because knobs are k-rate: read once per quantum, as in the worklet.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "ampcore/biquad.hpp"
#include "ampcore/cab.hpp"
#include "ampcore/convolver.hpp"
#include "ampcore/pedals.hpp"
#include "ampcore/reverb.hpp"
#include "ampcore/wav.hpp"

using namespace ampcore;

namespace {

int flag(int argc, char** argv, const char* name, int dflt) {
    for (int i = 1; i + 1 < argc; i++) if (!std::strcmp(argv[i], name)) return std::atoi(argv[i + 1]);
    return dflt;
}

CabOpts cabArgs(int argc, char** argv, int from) {
    CabOpts o;
    o.speaker = argv[from];
    for (int i = from + 1; i < argc; i++) {
        const std::string a = argv[i];
        const auto eq = a.find('=');
        if (eq != std::string::npos) o.num[a.substr(0, eq)] = std::atof(a.substr(eq + 1).c_str());
    }
    return o;
}

/** The input with renderStimulus()'s 2 s tail on the end. */
std::vector<float> withTail(const Wav& w) {
    std::vector<float> x = w.mono;
    x.resize(x.size() + static_cast<size_t>(w.rate * 2 + 0.5), 0.0f);
    return x;
}

/** Run `f(in, out, n)` over x in host-sized blocks. */
template <typename F>
void blocks(size_t len, int block, F f) {
    for (size_t at = 0; at < len; at += block) f(at, static_cast<int>(std::min<size_t>(block, len - at)));
}

}  // namespace

int main(int argc, char** argv) {
    if (argc >= 8 && !std::strcmp(argv[1], "biquad")) {
        const std::string t = argv[2];
        const Biquad::Type type = t == "lowpass" ? Biquad::Lowpass : t == "highpass" ? Biquad::Highpass
            : t == "peaking" ? Biquad::Peaking : Biquad::Lowshelf;
        for (int i = 8; i < argc; i++) if (!std::strcmp(argv[i], "--float-state")) Biquad::floatState = true;
        Wav in = readWav(argv[6]);
        Biquad bq(type, in.rate, std::atof(argv[3]), std::atof(argv[4]), std::atof(argv[5]));
        std::vector<float> y(in.mono.size());
        for (size_t at = 0; at < y.size(); at += 128) {
            const int n = static_cast<int>(std::min<size_t>(128, y.size() - at));
            bq.process(&in.mono[at], &y[at], n);
        }
        writeWavFloat(argv[7], y, in.rate);
        return 0;
    }
    if (argc >= 4 && !std::strcmp(argv[1], "cab")) {
        writeWavFloat(argv[2], renderCab(48000, cabArgs(argc, argv, 3)), 48000);
        return 0;
    }
    if (argc >= 4 && !std::strcmp(argv[1], "spring")) {
        const auto ir = springIR(48000);
        writeWavFloat(argv[2], ir[0], 48000);
        writeWavFloat(argv[3], ir[1], 48000);
        return 0;
    }
    if (argc >= 5 && !std::strcmp(argv[1], "conv")) {
        const std::string kind = argv[2];
        const int partition = flag(argc, argv, "--partition", 128);
        const int block = flag(argc, argv, "--block", 128);
        if (kind == "spring" && argc >= 6) {
            const Wav in = readWav(argv[3]);
            const std::vector<float> x = withTail(in);
            Reverb verb(springIR(in.rate), in.rate, true, partition);
            std::vector<float> l(x.size()), r(x.size());
            blocks(x.size(), block, [&](size_t at, int n) { verb.process(&x[at], &l[at], &r[at], n); });
            writeWavFloat(argv[4], l, in.rate);
            writeWavFloat(argv[5], r, in.rate);
            return 0;
        }
        if ((kind == "cab" && argc >= 6) || (kind == "ir" && argc >= 6)) {
            const Wav in = readWav(kind == "cab" ? argv[3] : argv[4]);
            const std::vector<float> ir = kind == "cab" ? renderCab(in.rate, cabArgs(argc, argv, 5)) : readWav(argv[3]).mono;
            const std::vector<float> x = withTail(in);
            Convolver conv(ir, 1, partition);
            std::vector<float> y(x.size());
            blocks(x.size(), block, [&](size_t at, int n) { conv.process(&x[at], &y[at], n); });
            writeWavFloat(kind == "cab" ? argv[4] : argv[5], y, in.rate);
            return 0;
        }
    }
    if (argc >= 5 && !std::strcmp(argv[1], "pedal")) {
        const Wav in = readWav(argv[3]);
        auto pedal = Pedal::create(argv[2], in.rate);
        if (!pedal) { std::fprintf(stderr, "no pedal type %s\n", argv[2]); return 2; }
        double on = 1;
        std::vector<size_t> flips;
        for (int i = 5; i < argc; i++) {
            const std::string a = argv[i];
            if (a == "--toggle" && i + 1 < argc) {
                for (const char* t = argv[++i]; *t;) {
                    char* end;
                    flips.push_back(static_cast<size_t>(std::strtod(t, &end) * in.rate + 0.5));
                    t = *end ? end + 1 : end;
                }
                continue;
            }
            const auto eq = a.find('=');
            if (eq == std::string::npos) continue;
            const double v = std::atof(a.substr(eq + 1).c_str());
            if (a.substr(0, eq) == "on") on = v;
            else pedal->set(a.substr(0, eq), v);
        }
        const std::vector<float> x = withTail(in);
        std::vector<float> y(x.size());
        blocks(x.size(), 128, [&](size_t at, int n) {
            for (size_t f : flips) if (f == at) on = on >= 0.5 ? 0 : 1;
            pedal->set("on", on);
            pedal->process(&x[at], &y[at], n);
        });
        writeWavFloat(argv[4], y, in.rate);
        return 0;
    }
    std::fprintf(stderr, "usage: see the top of tools/test.cpp\n");
    return 2;
}
