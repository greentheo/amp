// ampcore-test: pieces of the chain on their own, for null tests against
// the browser build.
//
//   ampcore-test biquad <lowpass|highpass|peaking|lowshelf> hz q db in.wav out.wav [--float-state]

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "ampcore/biquad.hpp"
#include "ampcore/cab.hpp"
#include "ampcore/wav.hpp"

using namespace ampcore;

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
        // ampcore-test cab out.wav speaker [key=value ...]   (rate 48000)
        CabOpts o;
        o.speaker = argv[3];
        for (int i = 4; i < argc; i++) {
            const std::string a = argv[i];
            const auto eq = a.find('=');
            if (eq != std::string::npos) o.num[a.substr(0, eq)] = std::atof(a.substr(eq + 1).c_str());
        }
        writeWavFloat(argv[2], renderCab(48000, o), 48000);
        return 0;
    }
    std::fprintf(stderr, "usage: ampcore-test biquad <type> hz q db in.wav out.wav [--float-state]\n");
    return 2;
}
