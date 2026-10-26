// The tuner's pitch detector: YIN, on the dry input.
//
// A tuner has to be right to a fraction of a cent and never jump an octave,
// and the guitar it listens to is about the easiest signal there is — one
// note, clean, straight off the pickups. YIN (de Cheveigné and Kawahara,
// 2002) suits that: it looks for the lag at which the signal best repeats
// itself, normalised so that the first good dip wins over its multiples.
// A parabola through the peak of the energy-normalised correlation there
// gives the period to a small part of a sample, and ignores the note fading.
//
// It is a port of js/audio/tuner.js and does the arithmetic in the same
// order, in double, so the two builds read the same note off the same
// samples (tools/tuner-parity.mjs). Nothing here allocates after
// construction, but it is still meant for the message thread, not the audio
// callback: one look at a low E is around a million multiply-adds.

#pragma once
#include <vector>

namespace ampcore {

struct Pitch {
    double hz = 0;       // 0 when there is no note
    double clarity = 0;  // 1 a perfect repeat, 0 none
    double rms = 0;      // the window's level
};

class PitchDetector {
public:
    /** From the 5-string bass's low B (31 Hz is just below it) to the top
     *  of a 24-fret guitar's high E string with room to spare. */
    static constexpr double MIN_HZ = 30;
    static constexpr double MAX_HZ = 1500;

    explicit PitchDetector(double rate);

    /** How many of the latest samples analyse() wants. */
    int window() const;

    /** The pitch of the last window() samples of `x` (n of them). */
    Pitch analyse(const float* x, int n);

private:
    double rate_;
    int minTau_, maxTau_, pad_;
    double a_ = 0;  // the low-pass's coefficient
    std::vector<double> d_, cm_, s_, e_;
};

}  // namespace ampcore
