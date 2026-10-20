#include "ampcore/chain.hpp"

#include <algorithm>
#include <cmath>

namespace ampcore {

namespace {

float asParam(double v) { return static_cast<float>(v); }

std::vector<BoardSlot> lane(const Json* list) {
    std::vector<BoardSlot> out;
    if (!list || list->type != Json::Array) return out;
    for (const Json& p : list->a) {
        BoardSlot slot;
        slot.uid = p.str("uid", "");
        slot.type = p.str("type", "");
        slot.on = p.truthy("on");
        if (const Json* vals = p.get("values"))
            for (const auto& kv : vals->o)
                if (kv.second.type == Json::Number) slot.values.emplace_back(kv.first, kv.second.n);
        out.push_back(std::move(slot));
    }
    return out;
}

/** setVoicing() in amp-worklet.js: overrides on top of the defaults, a
 *  stage row's null entries keeping theirs. */
Voicing voicingFrom(const Json* v) {
    Voicing V;
    if (!v || v->type != Json::Object) return V;
    V.decades = v->num("decades", V.decades);
    V.scale = v->num("scale", V.scale);
    V.soft = v->str("curve", V.soft ? "soft" : "exp") == "soft";
    V.knee = v->num("knee", V.knee);
    V.stageGain = v->num("stageGain", V.stageGain);
    V.stageGainDrive = v->num("stageGainDrive", V.stageGainDrive);
    V.makeup = v->num("makeup", V.makeup);
    V.paDrive = v->num("paDrive", V.paDrive);
    V.paKp = v->num("paKp", V.paKp);
    V.paKn = v->num("paKn", V.paKn);
    V.sagDepth = v->num("sagDepth", V.sagDepth);
    V.xfmrHp = v->num("xfmrHp", V.xfmrHp);
    V.xfmrLp = v->num("xfmrLp", V.xfmrLp);
    V.presenceHz = v->num("presenceHz", V.presenceHz);
    V.presenceAmt = v->num("presenceAmt", V.presenceAmt);
    V.out = v->num("out", V.out);
    if (const Json* st = v->get("stages"); st && st->type == Json::Array)
        for (size_t i = 0; i < st->a.size() && i < V.stages.size(); i++)
            if (st->a[i].type == Json::Array)
                for (size_t j = 0; j < st->a[i].a.size() && j < 4; j++)
                    if (st->a[i].a[j].type == Json::Number) V.stages[i][j] = st->a[i].a[j].n;
    return V;
}

std::vector<std::unique_ptr<Pedal>> build(const std::vector<BoardSlot>& slots, double rate) {
    std::vector<std::unique_ptr<Pedal>> out;
    for (const auto& s : slots) {
        auto p = Pedal::create(s.type, rate);
        if (!p) continue;  // as buildPedals skips a type it does not know
        p->set("on", s.on ? 1 : 0);
        for (const auto& kv : s.values) p->set(kv.first, kv.second);
        out.push_back(std::move(p));
    }
    return out;
}

}  // namespace

ChainSettings ChainSettings::fromJson(const Json& j) {
    ChainSettings s;
    if (const Json* a = j.get("amp")) {
        s.amp.drive = a->num("drive", s.amp.drive);
        s.amp.bias = a->num("bias", s.amp.bias);
        s.amp.presence = a->num("presence", s.amp.presence);
        s.amp.sag = a->num("sag", s.amp.sag);
        s.amp.masterVol = a->num("masterVol", s.amp.masterVol);
        s.amp.gate = a->num("gate", s.amp.gate);
        s.amp.stages = a->num("stages", s.amp.stages);
    }
    if (const Json* t = j.get("tone")) {
        s.stack = t->str("stack", s.stack);
        s.treble = t->num("treble", s.treble);
        s.mid = t->num("mid", s.mid);
        s.bass = t->num("bass", s.bass);
    }
    s.voicing = voicingFrom(j.get("voicing"));
    if (const Json* c = j.get("cab"); c && c->type == Json::Object) {
        // Exactly the numeric keys present: they seed the cab's noise.
        s.cab.speaker = c->str("speaker", s.cab.speaker);
        s.cab.num.clear();
        for (const auto& kv : c->o)
            if (kv.second.type == Json::Number) s.cab.num[kv.first] = kv.second.n;
    }
    s.cabMix = j.num("cabMix", s.cabMix);
    s.reverb = j.num("reverb", s.reverb);
    s.master = j.num("master", s.master);
    if (const Json* b = j.get("board")) {
        s.pre = lane(b->get("pre"));
        s.post = lane(b->get("post"));
    }
    return s;
}

Chain::Chain(double rate, const ChainSettings& s)
    : rate_(rate),
      mix_(s.cabMix), mixTo_(s.cabMix), sendNow_(s.reverb), sendTo_(s.reverb),
      masterNow_(s.master), masterTo_(s.master),
      stack_(s.stack), treble_(s.treble), mid_(s.mid), bass_(s.bass),
      amp_(rate, s.voicing),
      cab_(buildCab(rate, s.cab)),
      verb_(springIR(rate), rate, true),
      limiter_(rate),
      lanes_(buildLanes(rate, s)),
      wet_(asParam(s.cabMix)),
      dry_(asParam(1 - s.cabMix)),
      send_(asParam(s.reverb)),
      master_(asParam(s.master)) {
    params_.drive = asParam(s.amp.drive);
    params_.bias = asParam(s.amp.bias);
    params_.presence = asParam(s.amp.presence);
    params_.sag = asParam(s.amp.sag);
    params_.masterVol = asParam(s.amp.masterVol);
    params_.gate = asParam(s.amp.gate);
    params_.stages = asParam(s.amp.stages);
    ampTo_ = params_;
    amp_.setTone(coeffs(s.stack, s.treble, s.mid, s.bass, rate * Amp::OS));
}

std::unique_ptr<Convolver> Chain::buildCab(double rate, const CabOpts& cab) {
    return std::make_unique<Convolver>(renderCab(rate, cab));
}

std::unique_ptr<ChainLanes> Chain::buildLanes(double rate, const ChainSettings& s) {
    auto lanes = std::make_unique<ChainLanes>();
    lanes->pre = build(s.pre, rate);
    lanes->post = build(s.post, rate);
    return lanes;
}

std::unique_ptr<Convolver> Chain::swapCab(std::unique_ptr<Convolver> next) {
    std::swap(cab_, next);
    return next;
}

std::unique_ptr<ChainLanes> Chain::swapLanes(std::unique_ptr<ChainLanes> next) {
    std::swap(lanes_, next);
    return next;
}

void Chain::setPedal(int lane, size_t index, const std::string& name, double value) {
    auto& list = lane == 0 ? lanes_->pre : lanes_->post;
    if (index >= list.size()) return;
    if (name == "on") list[index]->set(name, value);
    else list[index]->glide(name, value);
}

void Chain::setAmp(const AmpParams& t) {
    ampTo_.drive = asParam(t.drive);
    ampTo_.bias = asParam(t.bias);
    ampTo_.presence = asParam(t.presence);
    ampTo_.sag = asParam(t.sag);
    ampTo_.masterVol = asParam(t.masterVol);
    ampTo_.gate = asParam(t.gate);
    // A stage count is a switch, not a knob: no glide.
    params_.stages = ampTo_.stages = asParam(t.stages);
    gliding_ = gliding_ || ampTo_.drive != params_.drive || ampTo_.bias != params_.bias
        || ampTo_.presence != params_.presence || ampTo_.sag != params_.sag
        || ampTo_.masterVol != params_.masterVol || ampTo_.gate != params_.gate;
}

void Chain::setMix(double cabMix, double reverb, double master) {
    mixTo_ = cabMix;
    sendTo_ = reverb;
    masterTo_ = master;
    gliding_ = gliding_ || mixTo_ != mix_ || sendTo_ != sendNow_ || masterTo_ != masterNow_;
}

void Chain::setTone(const std::string& stack, double treble, double mid, double bass) {
    if (stack == stack_ && treble == treble_ && mid == mid_ && bass == bass_) return;
    stack_ = stack;
    treble_ = treble;
    mid_ = mid;
    bass_ = bass;
    amp_.setTone(coeffs(stack_, treble_, mid_, bass_, rate_ * Amp::OS));
}

void Chain::glide(int frames) {
    if (!gliding_) return;
    auto step = [&](double& v, double to, double tau) {
        v += (to - v) * (1 - std::exp(-frames / (tau * rate_)));
        if (std::fabs(to - v) < 1e-7) v = to;
    };
    step(params_.drive, ampTo_.drive, 0.02);
    step(params_.bias, ampTo_.bias, 0.02);
    step(params_.presence, ampTo_.presence, 0.02);
    step(params_.sag, ampTo_.sag, 0.02);
    step(params_.masterVol, ampTo_.masterVol, 0.02);
    step(params_.gate, ampTo_.gate, 0.02);
    step(mix_, mixTo_, 0.03);
    step(sendNow_, sendTo_, 0.05);
    step(masterNow_, masterTo_, 0.03);
    wet_ = asParam(mix_);
    dry_ = asParam(1 - mix_);
    send_ = asParam(sendNow_);
    master_ = asParam(masterNow_);
    // Arrived: stop stepping until something moves again.
    gliding_ = params_.drive != ampTo_.drive || params_.bias != ampTo_.bias
        || params_.presence != ampTo_.presence || params_.sag != ampTo_.sag
        || params_.masterVol != ampTo_.masterVol || params_.gate != ampTo_.gate
        || mix_ != mixTo_ || sendNow_ != sendTo_ || masterNow_ != masterTo_;
}

void Chain::process(const float* in, float* outL, float* outR, int n) {
    for (int at = 0; at < n; at += MAX_BLOCK) {
        const int m = std::min(MAX_BLOCK, n - at);
        glide(m);
        float* a = a_;
        std::copy(in + at, in + at + m, a);
        for (auto& p : lanes_->pre) p->process(a, a, m);
        amp_.process(a, b_, m, params_);
        cab_->process(b_, c_, m);
        // Two GainNodes into one summing junction: each output is a float
        // buffer before the sum, so each product is rounded on its own.
        for (int i = 0; i < m; i++) {
            const float w = c_[i] * wet_;
            const float d = b_[i] * dry_;
            a[i] = w + d;
        }
        for (auto& p : lanes_->post) p->process(a, a, m);
        for (int i = 0; i < m; i++) b_[i] = a[i] * send_;
        verb_.process(b_, vl_, vr_, m);
        // The dry path upmixed to both sides, the reverb's two channels on
        // top, then the master gain.
        float* L = outL + at;
        float* R = outR + at;
        for (int i = 0; i < m; i++) {
            L[i] = static_cast<float>(a[i] + vl_[i]) * master_;
            R[i] = static_cast<float>(a[i] + vr_[i]) * master_;
        }
        float* ch[2] = {L, R};
        limiter_.process(ch, 2, m);
    }
}

}  // namespace ampcore
