#include "ampcore/pedals.hpp"

#include <algorithm>
#include <array>
#include <cmath>

#include "ampcore/resampler.hpp"

namespace ampcore {

namespace {

constexpr int OS = Resampler::OS;

inline double poleAt(double hz, double rate) { return 1 - std::exp((-2 * M_PI * hz) / rate); }
inline double dbGain(double db) { return std::pow(10.0, db / 20); }
/** Level knobs everywhere: -12..+12 dB, unity at noon. */
inline double levelGain(double v) { return dbGain((v - 0.5) * 24); }

/** Soft clipper with a knee-hardness parameter, saturating at +-1. */
inline double clip(double x, double h) { return x / std::pow(1 + std::pow(std::fabs(x), h), 1 / h); }

/** Cubic Hermite read from a circular buffer, `d` samples behind `w`. */
double readHermite(const std::vector<float>& buf, int w, double d) {
    const int len = static_cast<int>(buf.size());
    double pos = w - d;
    while (pos < 0) pos += len;
    const int i1 = static_cast<int>(std::floor(pos));
    const double f = pos - i1;
    const int i0 = (i1 - 1 + len) % len, i2 = (i1 + 1) % len, i3 = (i1 + 2) % len;
    const double y0 = buf[i0], y1 = buf[i1 % len], y2 = buf[i2], y3 = buf[i3];
    const double c1 = 0.5 * (y2 - y0);
    const double c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const double c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * f + c2) * f + c1) * f + y1;
}

inline double in(const float* x, int i) { return x ? x[i] : 0.0; }

/* Overdrive: the green one. See pedal-worklet.js for the circuit story. */
class Overdrive : public Pedal {
public:
    explicit Overdrive(double rate)
        : Pedal(rate, {{"on", 0}, {"drive", 0.4f}, {"tone", 0.5f}, {"level", 0.5f}}), rs_(rate) {
        const double hi = rate * OS;
        aHp_ = poleAt(720, hi);
        aLp_ = poleAt(6000, hi);
    }

private:
    void idle() override { rs_.reset(); hp_ = lp_ = tone_ = 0; }

    void render(const float* x, float* y, int n, int on) override {
        const double g = 11.9 * std::pow(10.0, knob(1));
        const double aTone = poleAt(400 * std::pow(25.0, knob(2)), rate_);
        const double lev = levelGain(knob(3)) * 0.45;
        float buf[OS];
        for (int i = 0; i < n; i++) {
            const double xi = in(x, i);
            rs_.up(xi, buf);
            for (int p = 0; p < OS; p++) {
                const double v = buf[p];
                hp_ += (v - hp_) * aHp_;
                const double w = v + 0.55 * clip(((v - hp_) * g) / 0.55, 2.2);
                lp_ += (w - lp_) * aLp_;
                buf[p] = static_cast<float>(lp_);
            }
            const double d = rs_.down(buf);
            tone_ += (d - tone_) * aTone;
            y[i] = static_cast<float>(blend(xi, tone_ * lev, on));
        }
    }

    Resampler rs_;
    double aHp_, aLp_;
    double hp_ = 0, lp_ = 0, tone_ = 0;
};

/* Fuzz: two clipping stages and the Muff's scooped tone blend. */
class Fuzz : public Pedal {
public:
    explicit Fuzz(double rate)
        : Pedal(rate, {{"on", 0}, {"fuzz", 0.6f}, {"tone", 0.5f}, {"level", 0.5f}}), rs_(rate) {
        const double hi = rate * OS;
        aIn_ = poleAt(90, hi);
        aMid_ = poleAt(1800, hi);
        aLo_ = poleAt(550, rate);
        aHi_ = poleAt(1300, rate);
    }

private:
    void idle() override { rs_.reset(); inHp_ = mid_ = lo_ = hiLp_ = 0; }

    void render(const float* x, float* y, int n, int on) override {
        const double f = knob(1);
        const double g1 = 6 + f * 70;
        const double g2 = 3 + f * 18;
        const double t = knob(2);
        const double lev = levelGain(knob(3)) * 0.45;
        float buf[OS];
        for (int i = 0; i < n; i++) {
            const double xi = in(x, i);
            rs_.up(xi, buf);
            for (int p = 0; p < OS; p++) {
                double v = buf[p];
                inHp_ += (v - inHp_) * aIn_;
                v = clip((v - inHp_) * g1, 4);
                mid_ += (v - mid_) * aMid_;
                buf[p] = static_cast<float>(clip(mid_ * g2, 4.5));
            }
            const double d = rs_.down(buf);
            lo_ += (d - lo_) * aLo_;
            hiLp_ += (d - hiLp_) * aHi_;
            const double tone = lo_ * (1 - t) + (d - hiLp_) * t;
            y[i] = static_cast<float>(blend(xi, tone * lev, on));
        }
    }

    Resampler rs_;
    double aIn_, aMid_, aLo_, aHi_;
    double inHp_ = 0, mid_ = 0, lo_ = 0, hiLp_ = 0;
};

/* Compressor: lets the pick through, then squashes the tail. */
class Compressor : public Pedal {
public:
    explicit Compressor(double rate)
        : Pedal(rate, {{"on", 0}, {"sustain", 0.5f}, {"attack", 0.45f}, {"level", 0.5f}}),
          aRel_(1 - std::exp(-1 / (0.25 * rate))) {}

private:
    void idle() override { env_ = 0; }

    void render(const float* x, float* y, int n, int on) override {
        const double thr = -12 - knob(1) * 30;
        const double ratio = 8;
        const double slope = 1 - 1 / ratio;
        const double makeup = -thr * slope * 0.55;
        const double atkMs = 1 * std::pow(40.0, knob(2));
        const double aAtk = 1 - std::exp(-1 / ((atkMs / 1000) * rate_));
        const double lev = levelGain(knob(3));
        for (int i = 0; i < n; i++) {
            const double xi = in(x, i);
            const double a = std::fabs(xi);
            env_ += (a - env_) * (a > env_ ? aAtk : aRel_);
            const double envDb = 20 * std::log10(env_ + 1e-9);
            const double gr = envDb > thr ? (envDb - thr) * slope : 0;
            y[i] = static_cast<float>(blend(xi, xi * dbGain(makeup - gr) * lev, on));
        }
    }

    const double aRel_;
    double env_ = 0;
};

/* Wah: a treadle-swept resonant band-pass, Zavalishin's SVF. */
class Wah : public Pedal {
public:
    explicit Wah(double rate)
        : Pedal(rate, {{"on", 0}, {"pedal", 0.5f}, {"q", 0.5f}, {"level", 0.5f}}),
          aPos_(1 - std::exp(-1 / (0.012 * rate))) {}

private:
    void idle() override { ic1_ = ic2_ = 0; }

    void render(const float* x, float* y, int n, int on) override {
        const double target = knob(1);
        const double qBase = 2 + knob(2) * 8;
        const double lev = levelGain(knob(3));
        for (int i = 0; i < n; i++) {
            const double xi = in(x, i);
            pos_ += (target - pos_) * aPos_;
            const double fc = 350 * std::pow(2300.0 / 350, pos_);
            const double Q = qBase * (0.75 + 0.5 * pos_);
            const double g = std::tan((M_PI * fc) / rate_);
            const double k = 1 / Q;
            const double a1 = 1 / (1 + g * (g + k));
            const double a2 = g * a1;
            const double a3 = g * a2;
            const double v3 = xi - ic2_;
            const double v1 = a1 * ic1_ + a2 * v3;
            const double v2 = ic2_ + a2 * ic1_ + a3 * v3;
            ic1_ = 2 * v1 - ic1_;
            ic2_ = 2 * v2 - ic2_;
            const double wet = (k * v1 * 2.4 + v2 * 0.22) * lev;
            y[i] = static_cast<float>(blend(xi, wet, on));
        }
    }

    const double aPos_;
    double ic1_ = 0, ic2_ = 0, pos_ = 0.5;
};

/* Boost: clean gain with a tilt. */
class Boost : public Pedal {
public:
    explicit Boost(double rate)
        : Pedal(rate, {{"on", 0}, {"gain", 0.4f}, {"tone", 0.5f}}),
          aSplit_(poleAt(800, rate)), aHp_(poleAt(70, rate)) {}

private:
    void idle() override { lo_ = hp_ = 0; }

    void render(const float* x, float* y, int n, int on) override {
        const double g = dbGain(knob(1) * 20);
        const double tilt = (knob(2) - 0.5) * 12;
        const double gLo = dbGain(-tilt / 2), gHi = dbGain(tilt / 2);
        for (int i = 0; i < n; i++) {
            const double xi = in(x, i);
            hp_ += (xi - hp_) * aHp_;
            const double v = xi - hp_;
            lo_ += (v - lo_) * aSplit_;
            y[i] = static_cast<float>(blend(xi, (lo_ * gLo + (v - lo_) * gHi) * g, on));
        }
    }

    const double aSplit_, aHp_;
    double lo_ = 0, hp_ = 0;
};

/* Phaser: six swept all-passes against the dry, with feedback. */
class Phaser : public Pedal {
public:
    explicit Phaser(double rate)
        : Pedal(rate, {{"on", 0}, {"rate", 0.35f}, {"depth", 0.7f}, {"feedback", 0.4f}}) {}

private:
    static constexpr int N = 6;

    void idle() override { xs_.fill(0); ys_.fill(0); last_ = 0; }

    void render(const float* x, float* y, int n, int on) override {
        const double hz = 0.05 * std::pow(160.0, knob(1));
        const double inc = (2 * M_PI * hz) / rate_;
        const double depth = knob(2);
        const double fb = knob(3) * 0.75;
        for (int i = 0; i < n; i++) {
            const double xi = in(x, i);
            ph_ += inc;
            if (ph_ > 2 * M_PI) ph_ -= 2 * M_PI;
            const double sweep = 0.5 + 0.5 * std::sin(ph_);
            const double fc = 220 * std::pow(10.0, depth * 1.1 * sweep);
            const double t = std::tan((M_PI * std::min(fc, rate_ * 0.45)) / rate_);
            const double a = (t - 1) / (t + 1);
            double v = xi + last_ * fb;
            for (int s = 0; s < N; s++) {
                const double out = a * v + xs_[s] - a * ys_[s];
                xs_[s] = static_cast<float>(v);
                ys_[s] = static_cast<float>(out);
                v = out;
            }
            if (std::fabs(v) < 1e-20) v = 0;
            last_ = v;
            y[i] = static_cast<float>(blend(xi, (xi + v) * 0.5 * 1.4, on));
        }
    }

    std::array<float, N> xs_{}, ys_{};  // Float32Arrays in the JS
    double ph_ = 0, last_ = 0;
};

/* Volume: an audio-taper swell pedal. */
class Volume : public Pedal {
public:
    explicit Volume(double rate)
        : Pedal(rate, {{"on", 0}, {"pedal", 1}}), aG_(1 - std::exp(-1 / (0.01 * rate))) {}

private:
    void render(const float* x, float* y, int n, int on) override {
        const double p = knob(1);
        const double target = p * p * p;
        for (int i = 0; i < n; i++) {
            const double xi = in(x, i);
            g_ += (target - g_) * aG_;
            y[i] = static_cast<float>(blend(xi, xi * g_, on));
        }
    }

    const double aG_;
    double g_ = 1;
};

/* Chorus: two voices on modulated delays, a quarter cycle apart. */
class Chorus : public Pedal {
public:
    explicit Chorus(double rate)
        : Pedal(rate, {{"on", 0}, {"rate", 0.35f}, {"depth", 0.5f}, {"mix", 0.7f}}),
          buf_(static_cast<size_t>(std::ceil(rate * 0.06)), 0.0f) {}

private:
    void idle() override { std::fill(buf_.begin(), buf_.end(), 0.0f); }

    void render(const float* x, float* y, int n, int on) override {
        const double hz = 0.05 * std::pow(100.0, knob(1));
        const double inc = (2 * M_PI * hz) / rate_;
        const double depth = knob(2) * 0.004 * rate_;
        const double b1 = 0.008 * rate_, b2 = 0.0115 * rate_;
        const double m = knob(3);
        const double dryG = std::cos((m * M_PI) / 4), wetG = std::sin((m * M_PI) / 4);
        const int len = static_cast<int>(buf_.size());
        for (int i = 0; i < n; i++) {
            const double xi = in(x, i);
            buf_[w_] = static_cast<float>(xi);
            ph_ += inc;
            if (ph_ > 2 * M_PI) ph_ -= 2 * M_PI;
            const double v1 = readHermite(buf_, w_, b1 + depth * (0.5 + 0.5 * std::sin(ph_)));
            const double v2 = readHermite(buf_, w_, b2 + depth * (0.5 + 0.5 * std::sin(ph_ + M_PI / 2)));
            w_ = (w_ + 1) % len;
            const double wet = xi * dryG + (v1 + v2) * 0.5 * wetG * 1.414;
            y[i] = static_cast<float>(blend(xi, wet, on));
        }
    }

    std::vector<float> buf_;
    int w_ = 0;
    double ph_ = 0;
};

/* Tremolo: a sine softened toward a square by the shape knob. */
class Tremolo : public Pedal {
public:
    explicit Tremolo(double rate)
        : Pedal(rate, {{"on", 0}, {"rate", 0.5f}, {"depth", 0.6f}, {"shape", 0.3f}}) {}

private:
    void render(const float* x, float* y, int n, int on) override {
        const double hz = 0.5 * std::pow(24.0, knob(1));
        const double inc = (2 * M_PI * hz) / rate_;
        const double depth = knob(2);
        const double k = 1 + knob(3) * 9;
        const double norm = std::tanh(k);
        for (int i = 0; i < n; i++) {
            const double xi = in(x, i);
            ph_ += inc;
            if (ph_ > 2 * M_PI) ph_ -= 2 * M_PI;
            const double s = std::tanh(k * std::sin(ph_)) / norm;
            const double g = 1 - depth * (1 - s) * 0.5;
            y[i] = static_cast<float>(blend(xi, xi * g, on));
        }
    }

    double ph_ = 0;
};

/* Delay: analogue darkening and tape wobble on two knobs; rings out when off. */
class Delay : public Pedal {
public:
    explicit Delay(double rate)
        : Pedal(rate, {{"on", 0}, {"time", 0.5f}, {"feedback", 0.35f}, {"mix", 0.35f},
                       {"tone", 0.5f}, {"mod", 0.15f}}),
          buf_(static_cast<size_t>(std::ceil(rate * 2.5)), 0.0f),
          d_(0.2 * rate),
          aD_(1 - std::exp(-1 / (0.08 * rate))),
          aFeed_(1 - std::exp(-1 / (0.006 * rate))) {}

private:
    bool trails() const override { return hold_ > 0; }
    void idle() override { std::fill(buf_.begin(), buf_.end(), 0.0f); lp_ = 0; hold_ = 0; }

    void render(const float* x, float* y, int n, int on) override {
        const double ms = 40 * std::pow(30.0, knob(1));
        const double target = (ms / 1000) * rate_;
        const double fb = knob(2) * 1.1;
        const double mix = knob(3);
        const double aTone = poleAt(1000 * std::pow(12.0, knob(4)), rate_);
        const double mod = knob(5);
        const double wowInc = (2 * M_PI * 0.55) / rate_;
        const double flutInc = (2 * M_PI * 6.3) / rate_;
        const int len = static_cast<int>(buf_.size());
        for (int i = 0; i < n; i++) {
            const double xi = in(x, i);
            d_ += (target - d_) * aD_;
            wow_ += wowInc; flut_ += flutInc;
            // The JS wraps at this literal, not at 2 * Math.PI.
            if (wow_ > 6.283185307) wow_ -= 6.283185307;
            if (flut_ > 6.283185307) flut_ -= 6.283185307;
            const double wobble = mod * rate_ * (0.0014 * std::sin(wow_) + 0.00018 * std::sin(flut_));
            const double r = readHermite(buf_, w_, std::max(4.0, d_ + wobble));
            lp_ += (r - lp_) * aTone;
            if (std::fabs(lp_) < 1e-20) lp_ = 0;
            feed_ += (on - feed_) * aFeed_;
            const double loop = lp_ * fb;
            const double sat = loop * (27 + loop * loop) / (27 + 9 * loop * loop);
            const double wr = xi * feed_ + std::max(-1.5, std::min(1.5, sat));
            buf_[w_] = static_cast<float>(wr);
            w_ = (w_ + 1) % len;
            if (std::fabs(wr) > 1e-4) hold_ = d_ + 4096;
            else if (hold_ > 0) hold_--;
            y[i] = static_cast<float>(xi + lp_ * mix);
        }
        mix_ = feed_;
    }

    std::vector<float> buf_;
    int w_ = 0;
    double d_;
    const double aD_, aFeed_;
    double lp_ = 0, feed_ = 0, hold_ = 0, wow_ = 0, flut_ = 0;
};

}  // namespace

Pedal::Pedal(double rate, std::vector<std::pair<std::string, float>> params)
    : rate_(rate), aMix_(1 - std::exp(-1 / (0.006 * rate))) {
    for (auto& p : params) {
        names_.push_back(std::move(p.first));
        values_.push_back(p.second);
    }
}

void Pedal::set(const std::string& name, double value) {
    for (size_t i = 0; i < names_.size(); i++)
        if (names_[i] == name) values_[i] = static_cast<float>(value);
}

void Pedal::process(const float* in, float* out, int n) {
    const int on = values_[0] >= 0.5f ? 1 : 0;
    if (on == 0 && mix_ < 1e-4 && !trails()) {
        // Settled into bypass: a straight copy, bit for bit.
        mix_ = 0;
        if (!in) std::fill(out, out + n, 0.0f);
        else if (in != out) std::copy(in, in + n, out);
        if (!idleDone_) { idle(); idleDone_ = true; }
    } else {
        idleDone_ = false;
        render(in, out, n, on);
    }
}

const std::vector<std::string>& Pedal::types() {
    static const std::vector<std::string> ids = {
        "comp", "wah", "boost", "overdrive", "fuzz", "volume", "chorus", "phaser", "tremolo", "delay",
    };
    return ids;
}

std::unique_ptr<Pedal> Pedal::create(const std::string& type, double rate) {
    if (type == "overdrive") return std::make_unique<Overdrive>(rate);
    if (type == "fuzz") return std::make_unique<Fuzz>(rate);
    if (type == "comp") return std::make_unique<Compressor>(rate);
    if (type == "wah") return std::make_unique<Wah>(rate);
    if (type == "boost") return std::make_unique<Boost>(rate);
    if (type == "phaser") return std::make_unique<Phaser>(rate);
    if (type == "volume") return std::make_unique<Volume>(rate);
    if (type == "chorus") return std::make_unique<Chorus>(rate);
    if (type == "tremolo") return std::make_unique<Tremolo>(rate);
    if (type == "delay") return std::make_unique<Delay>(rate);
    return nullptr;
}

}  // namespace ampcore
