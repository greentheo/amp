#include "ampcore/tonestack.hpp"

#include <cmath>

namespace ampcore {

static const Stack STACKS[] = {
    {"bassman", "Fender '59 Bassman", 250e3, 1e6, 25e3, 56e3, 250e-12, 20e-9, 20e-9},
    {"twin", "Fender '69 Twin", 250e3, 250e3, 10e3, 100e3, 120e-12, 100e-9, 47e-9},
    {"jcm800", "Marshall JCM800", 220e3, 1e6, 22e3, 33e3, 470e-12, 22e-9, 22e-9},
    {"jtm45", "Marshall JTM45", 250e3, 1e6, 25e3, 33e3, 270e-12, 22e-9, 22e-9},
    {"ac30", "Vox AC30", 1e6, 1e6, 10e3, 100e3, 50e-12, 22e-9, 22e-9},
    {"soldano", "Soldano SLO100", 250e3, 1e6, 25e3, 47e3, 470e-12, 20e-9, 20e-9},
};

const Stack& findStack(const std::string& id) {
    for (const auto& s : STACKS)
        if (id == s.id) return s;
    return STACKS[2];  // jcm800
}

Analog analogCoeffs(const Stack& p, double t, double m, double L) {
    const double R1 = p.R1, R2 = p.R2, R3 = p.R3, R4 = p.R4, C1 = p.C1, C2 = p.C2, C3 = p.C3;
    const double l = std::exp((L - 1) * 3.4);

    const double b1 = t * C1 * R1 + m * C3 * R3 + l * (C1 * R2 + C2 * R2) + (C1 * R3 + C2 * R3);

    const double b2 = t * (C1 * C2 * R1 * R4 + C1 * C3 * R1 * R4)
        - m * m * (C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3)
        + m * (C1 * C3 * R1 * R3 + C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3)
        + l * (C1 * C2 * R1 * R2 + C1 * C2 * R2 * R4 + C1 * C3 * R2 * R4)
        + l * m * (C1 * C3 * R2 * R3 + C2 * C3 * R2 * R3)
        + (C1 * C2 * R1 * R3 + C1 * C2 * R3 * R4 + C1 * C3 * R3 * R4);

    const double b3 = l * m * (C1 * C2 * C3 * R1 * R2 * R3 + C1 * C2 * C3 * R2 * R3 * R4)
        - m * m * (C1 * C2 * C3 * R1 * R3 * R3 + C1 * C2 * C3 * R3 * R3 * R4)
        + m * (C1 * C2 * C3 * R1 * R3 * R3 + C1 * C2 * C3 * R3 * R3 * R4)
        + t * C1 * C2 * C3 * R1 * R3 * R4 - t * m * C1 * C2 * C3 * R1 * R3 * R4
        + t * l * C1 * C2 * C3 * R1 * R2 * R4;

    const double a0 = 1;

    const double a1 = (C1 * R1 + C1 * R3 + C2 * R3 + C2 * R4 + C3 * R4)
        + m * C3 * R3 + l * (C1 * R2 + C2 * R2);

    const double a2 = m * (C1 * C3 * R1 * R3 - C2 * C3 * R3 * R4 + C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3)
        + l * m * (C1 * C3 * R2 * R3 + C2 * C3 * R2 * R3)
        - m * m * (C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3)
        + l * (C1 * C2 * R2 * R4 + C1 * C2 * R1 * R2 + C1 * C3 * R2 * R4 + C2 * C3 * R2 * R4)
        + (C1 * C2 * R1 * R4 + C1 * C3 * R1 * R4 + C1 * C2 * R3 * R4 + C1 * C2 * R1 * R3
           + C1 * C3 * R3 * R4 + C2 * C3 * R3 * R4);

    const double a3 = l * m * (C1 * C2 * C3 * R1 * R2 * R3 + C1 * C2 * C3 * R2 * R3 * R4)
        - m * m * (C1 * C2 * C3 * R1 * R3 * R3 + C1 * C2 * C3 * R3 * R3 * R4)
        + m * (C1 * C2 * C3 * R3 * R3 * R4 + C1 * C2 * C3 * R1 * R3 * R3 - C1 * C2 * C3 * R1 * R3 * R4)
        + l * C1 * C2 * C3 * R1 * R2 * R4
        + C1 * C2 * C3 * R1 * R3 * R4;

    return {b1, b2, b3, a0, a1, a2, a3};
}

double analogResponse(const Analog& c, double hz) {
    const double w = 2 * M_PI * hz;
    const double nRe = -c.b2 * w * w;
    const double nIm = c.b1 * w - c.b3 * w * w * w;
    const double dRe = c.a0 - c.a2 * w * w;
    const double dIm = c.a1 * w - c.a3 * w * w * w;
    const double den = dRe * dRe + dIm * dIm;
    const double re = (nRe * dRe + nIm * dIm) / den;
    const double im = (nIm * dRe - nRe * dIm) / den;
    return std::hypot(re, im);
}

ToneCoeffs coeffs(const std::string& stack, double t, double m, double l, double rate) {
    const Analog c = analogCoeffs(findStack(stack), t, m, l);
    const double r2 = 1 / c.a2;
    const double r3 = 1 / c.a3;
    const double rw = c.a3 * r2;
    const double g = c.a2 * r3 * 0.5 / rate;
    const double al1 = c.a1 * r2 * rw;
    const double al0 = c.a0 * r2 * rw * rw;
    const double be3 = c.b3 * r3;
    const double be2 = c.b2 * r2;
    const double be1 = c.b1 * r2 * rw;
    const double dn = 1 / (1 + g * (1 + g * (al1 + g * al0)));
    const double nx = be3 + g * (be2 + g * be1);
    return {g, al0, al1, be1, be2, be3, dn, nx};
}

}  // namespace ampcore
