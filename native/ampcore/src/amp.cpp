#include "ampcore/amp.hpp"

#include <algorithm>
#include <cmath>

namespace ampcore {

namespace {

/** One-pole smoothing coefficient for a corner frequency. */
inline double poleAt(double hz, double rate) {
    return 1 - std::exp((-2 * M_PI * hz) / rate);
}

/** Valve curve: grid conduction one side, cutoff the other. */
inline double tube(double x, double kp, double kn) {
    return x >= 0 ? (1 - std::exp(-kp * x)) / kp : -(1 - std::exp(kn * x)) / kn;
}

inline double softTube(double x, double kp, double kn, double h) {
    const double k = x >= 0 ? kp : kn;
    const double a = std::fabs(k * x);
    return x / std::pow(1 + std::pow(a, h), 1 / h);
}

}  // namespace

double Amp::Stage::run(double x, double gain, double bias) {
    hp += (x - hp) * aHp;
    const double u = (x - hp) * gain + bias;
    double y = soft ? softTube(u, kp, kn, knee) : tube(u, kp, kn);
    lp += (y - lp) * aLp;
    y = lp;
    dc += (y - dc) * aDc;
    return y - dc;
}

Amp::Amp(double sampleRate, const Voicing& v) : rate_(sampleRate), hi_(sampleRate * OS), v_(v), rs_(sampleRate) {
    buildStages();
    tuneOutput();
    aSagUp_ = poleAt(14, hi_);
    aSagDn_ = poleAt(2.5, hi_);
    aGate_ = poleAt(20, rate_);
}

void Amp::setVoicing(const Voicing& v) {
    v_ = v;
    buildStages();
    tuneOutput();
}

void Amp::buildStages() {
    // A rebuild starts each stage's filters from rest, as `new Stage` does.
    for (int s = 0; s < 4; s++) {
        const auto& r = v_.stages[s];
        Stage st;
        st.aHp = poleAt(r[0], hi_);
        st.aLp = poleAt(r[1], hi_);
        st.aDc = poleAt(8, hi_);
        st.kp = r[2];
        st.kn = r[3];
        st.soft = v_.soft;
        st.knee = v_.knee;
        stages_[s] = st;
    }
}

void Amp::tuneOutput() {
    aAmpHp_ = poleAt(v_.xfmrHp, hi_);
    aAmpLp_ = poleAt(v_.xfmrLp, hi_);
    aPres_ = poleAt(v_.presenceHz, hi_);
}

void Amp::reset() {
    tsState_[0] = tsState_[1] = tsState_[2] = 0;
    rs_.reset();
    ampHp_ = ampLp_ = presLp_ = sagEnv_ = 0;
    for (auto& s : stages_) s.hp = s.lp = s.dc = 0;
}

void Amp::process(const float* in, float* out, int n, const AmpParams& p) {
    const double drive = p.drive, bias = p.bias, presence = p.presence;
    const double sagAmt = p.sag, master = p.masterVol, gateThresh = p.gate;
    const int nStages = std::max(1, std::min(4, static_cast<int>(std::lround(p.stages))));
    const Voicing& V = v_;
    const double g = std::pow(10.0, drive * V.decades) * V.scale;
    float buf[OS];

    for (int i = 0; i < n; i++) {
        double x = in ? in[i] : 0.0;

        const double a = std::fabs(x);
        gateEnv_ += (a - gateEnv_) * (a > gateEnv_ ? 0.4 : aGate_);
        if (gateThresh > 0.001) {
            const double thr = gateThresh * 0.08;
            const double want = gateEnv_ > thr ? 1 : 0;
            gateOpen_ += (want - gateOpen_) * (want > gateOpen_ ? 0.25 : 0.004);
            x *= gateOpen_;
        }

        rs_.up(x, buf);

        for (int q = 0; q < OS; q++) {
            double y = buf[q];
            for (int s = 0; s < nStages; s++) {
                y = stages_[s].run(y, s == 0 ? g : V.stageGain + g * V.stageGainDrive, bias * (s + 1) * 0.3);
                if (s == 1 && hasTone_) y = toneStep(tone_, tsState_, y) * V.makeup;
            }

            y *= V.paDrive;
            const double e = std::fabs(y);
            sagEnv_ += (e - sagEnv_) * (e > sagEnv_ ? aSagUp_ : aSagDn_);
            const double head = 1 - sagAmt * V.sagDepth * std::min(1.0, sagEnv_);
            const double z = y / std::max(0.2, head);
            y = (tube(z, V.paKp, V.paKn) - tube(-z, V.paKp, V.paKn)) * 0.5 * head;

            ampHp_ += (y - ampHp_) * aAmpHp_;
            y -= ampHp_;
            ampLp_ += (y - ampLp_) * aAmpLp_;
            y = ampLp_;

            presLp_ += (y - presLp_) * aPres_;
            y += (y - presLp_) * presence * V.presenceAmt;

            buf[q] = static_cast<float>(y);
        }

        double o = rs_.down(buf) * master * V.out;
        if (!std::isfinite(o)) { o = 0; reset(); }
        o = std::max(-1.2, std::min(1.2, o));
        out[i] = static_cast<float>(o);
    }
}

OutLimiter::OutLimiter(double sampleRate)
    : ceil_(std::pow(10.0, -1.0 / 20)), rel_(std::exp(-1 / (0.08 * sampleRate))) {}

void OutLimiter::process(float* const* ch, int channels, int n) {
    for (int i = 0; i < n; i++) {
        double p = 0;
        for (int c = 0; c < channels; c++) {
            double v = ch[c][i];
            if (!std::isfinite(v)) { v = 0; ch[c][i] = 0; }
            const double a = v < 0 ? -v : v;
            if (a > p) p = a;
        }
        const double decayed = env_ * rel_;
        env_ = p > decayed ? p : decayed;
        if (env_ > ceil_) {
            const double g = ceil_ / env_;
            for (int c = 0; c < channels; c++) ch[c][i] = static_cast<float>(ch[c][i] * g);
        }
    }
}

}  // namespace ampcore
