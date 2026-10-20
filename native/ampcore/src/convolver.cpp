#include "ampcore/convolver.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace ampcore {

Convolver::Convolver(const std::vector<float>& ir, double scale, int partition)
    : p_(partition), n_(2 * partition), bins_(partition + 1) {
    if (p_ < 1 || (p_ & (p_ - 1))) throw std::invalid_argument("partition must be a power of two");

    // Bit reversal and twiddles for an n_-point radix-2 FFT.
    int bits = 0;
    while ((1 << bits) < n_) bits++;
    bitrev_.resize(n_);
    for (int i = 0; i < n_; i++) {
        int r = 0;
        for (int b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
        bitrev_[i] = r;
    }
    cos_.resize(n_ / 2);
    sin_.resize(n_ / 2);
    for (int k = 0; k < n_ / 2; k++) {
        cos_[k] = std::cos(2 * M_PI * k / n_);
        sin_[k] = std::sin(2 * M_PI * k / n_);
    }

    const int len = static_cast<int>(ir.size());
    head_.assign(p_, 0.0);
    for (int k = 0; k < std::min(p_, len); k++) head_[p_ - 1 - k] = ir[k] * scale;
    hist_.assign(2 * p_, 0.0);

    parts_ = len > p_ ? (len - p_ + p_ - 1) / p_ : 0;
    hRe_.assign(size_t(parts_) * bins_, 0.0);
    hIm_.assign(size_t(parts_) * bins_, 0.0);
    xRe_.assign(size_t(parts_) * bins_, 0.0);
    xIm_.assign(size_t(parts_) * bins_, 0.0);
    wRe_.assign(n_, 0.0);
    wIm_.assign(n_, 0.0);
    for (int i = 0; i < parts_; i++) {
        // Partition i holds taps p_ + i*p_ onward, zero-padded to n_.
        std::fill(wRe_.begin(), wRe_.end(), 0.0);
        std::fill(wIm_.begin(), wIm_.end(), 0.0);
        for (int k = 0; k < p_; k++) {
            const int t = p_ + i * p_ + k;
            if (t < len) wRe_[k] = ir[t] * scale;
        }
        fft(wRe_.data(), wIm_.data(), false);
        std::copy(wRe_.begin(), wRe_.begin() + bins_, hRe_.begin() + size_t(i) * bins_);
        std::copy(wIm_.begin(), wIm_.begin() + bins_, hIm_.begin() + size_t(i) * bins_);
    }
    block_.assign(n_, 0.0);
    tailOut_.assign(p_, 0.0);
}

void Convolver::reset() {
    std::fill(hist_.begin(), hist_.end(), 0.0);
    std::fill(xRe_.begin(), xRe_.end(), 0.0);
    std::fill(xIm_.begin(), xIm_.end(), 0.0);
    std::fill(block_.begin(), block_.end(), 0.0);
    std::fill(tailOut_.begin(), tailOut_.end(), 0.0);
    histPos_ = fdlPos_ = pos_ = 0;
}

void Convolver::fft(double* re, double* im, bool inverse) const {
    for (int i = 0; i < n_; i++) {
        const int j = bitrev_[i];
        if (j > i) { std::swap(re[i], re[j]); std::swap(im[i], im[j]); }
    }
    const double sign = inverse ? 1 : -1;
    for (int size = 2; size <= n_; size <<= 1) {
        const int half = size >> 1, step = n_ / size;
        for (int start = 0; start < n_; start += size) {
            for (int k = 0; k < half; k++) {
                const double wr = cos_[k * step], wi = sign * sin_[k * step];
                const int a = start + k, b = a + half;
                const double tr = re[b] * wr - im[b] * wi;
                const double ti = re[b] * wi + im[b] * wr;
                re[b] = re[a] - tr; im[b] = im[a] - ti;
                re[a] += tr; im[a] += ti;
            }
        }
    }
}

void Convolver::runTail() {
    // Transform [previous block, this block] into the delay line's newest slot.
    std::copy(block_.begin(), block_.end(), wRe_.begin());
    std::fill(wIm_.begin(), wIm_.end(), 0.0);
    fft(wRe_.data(), wIm_.data(), false);
    const size_t slot = size_t(fdlPos_) * bins_;
    std::copy(wRe_.begin(), wRe_.begin() + bins_, xRe_.begin() + slot);
    std::copy(wIm_.begin(), wIm_.begin() + bins_, xIm_.begin() + slot);

    // Y = sum over partitions of X[newest - i] * H[i]. Real input, so only
    // bins 0..p_ are kept; the rest are their mirror's conjugates.
    std::vector<double>& yr = wRe_;
    std::vector<double>& yi = wIm_;
    std::fill(yr.begin(), yr.end(), 0.0);
    std::fill(yi.begin(), yi.end(), 0.0);
    for (int i = 0; i < parts_; i++) {
        int s = fdlPos_ - i;
        if (s < 0) s += parts_;
        const double* xr = &xRe_[size_t(s) * bins_];
        const double* xi = &xIm_[size_t(s) * bins_];
        const double* hr = &hRe_[size_t(i) * bins_];
        const double* hi = &hIm_[size_t(i) * bins_];
        for (int k = 0; k < bins_; k++) {
            yr[k] += xr[k] * hr[k] - xi[k] * hi[k];
            yi[k] += xr[k] * hi[k] + xi[k] * hr[k];
        }
    }
    for (int k = bins_; k < n_; k++) { yr[k] = yr[n_ - k]; yi[k] = -yi[n_ - k]; }
    fft(yr.data(), yi.data(), true);
    // Overlap-save: the last p_ points are the ones free of wrap-around.
    for (int k = 0; k < p_; k++) tailOut_[k] = yr[p_ + k] / n_;

    fdlPos_ = fdlPos_ + 1 == parts_ ? 0 : fdlPos_ + 1;
    std::copy(block_.begin() + p_, block_.end(), block_.begin());
}

void Convolver::process(const float* in, float* out, int n) {
    for (int i = 0; i < n; i++) {
        const double x = in[i];
        hist_[histPos_] = hist_[histPos_ + p_] = x;
        // hist_[histPos_ + 1 .. histPos_ + p_] is the last p_ inputs, oldest first.
        const double* w = &hist_[histPos_ + 1];
        double y = 0;
        for (int k = 0; k < p_; k++) y += head_[k] * w[k];
        histPos_ = histPos_ + 1 == p_ ? 0 : histPos_ + 1;

        block_[p_ + pos_] = x;
        out[i] = static_cast<float>(y + tailOut_[pos_]);
        if (++pos_ == p_) {
            pos_ = 0;
            if (parts_) runTail();
        }
    }
}

}  // namespace ampcore
