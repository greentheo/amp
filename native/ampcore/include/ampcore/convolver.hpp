// Convolution with a fixed impulse response, at zero latency — the native
// ConvolverNode.
//
// The first `partition` taps run as a direct convolution, sample by sample.
// The rest run as a uniformly partitioned FFT convolution (overlap-save, a
// frequency-domain delay line) in blocks of `partition`. The tail's first tap
// is `partition` samples in, so the block of output it owes is due exactly
// when the block of input that makes it has arrived: no latency, and any host
// block size works, down to one sample.
//
// Chromium does the same split — a direct first stage, FFT stages after —
// though its FFT stages grow in size along the response. Uniform partitions
// cost more for a long tail but keep the work per block flat. The FFT work
// lands on the sample that completes a block, so a host block smaller than
// the partition carries it all in one callback out of every few; moving the
// tail to a worker thread is the fix if that ever shows up as dropouts.
//
// Arithmetic is double throughout, then rounded to float on output. The
// browser's convolver is float, so the null test measures its rounding, not
// ours.

#pragma once
#include <vector>

namespace ampcore {

class Convolver {
public:
    /**
     * @param ir the impulse response
     * @param scale applied to it — how ConvolverNode's normalisation enters
     * @param partition direct-convolution length and FFT block size; a power
     *   of two
     */
    explicit Convolver(const std::vector<float>& ir, double scale = 1, int partition = 128);

    void process(const float* in, float* out, int n);
    void reset();

private:
    void fft(double* re, double* im, bool inverse) const;
    void runTail();

    int p_, n_, bins_, parts_ = 0;
    std::vector<int> bitrev_;
    std::vector<double> cos_, sin_;

    std::vector<double> head_;  // the first p_ taps, reversed
    std::vector<double> hist_;  // the last p_ inputs, written twice so a window is contiguous
    int histPos_ = 0;

    std::vector<double> hRe_, hIm_;  // the tail's partitions, transformed: parts_ x bins_
    std::vector<double> xRe_, xIm_;  // the frequency-domain delay line, the same shape
    int fdlPos_ = 0;
    std::vector<double> block_;      // the previous block of input, then the current one
    std::vector<double> tailOut_;    // the tail's share of the next p_ outputs
    std::vector<double> wRe_, wIm_;  // FFT workspace
    int pos_ = 0;
};

}  // namespace ampcore
