// The passive tone stack, ported from js/audio/tonestack.js.
//
// Yeh and Smith's third-order analysis, discretised by bilinear transform
// into an observable canonical form of trapezoidal integrators. See the JS
// file for why that form and not a direct one: a direct form clusters its
// poles near z = 1 and clicks whenever a knob moves.
//
// Line for line with the JS on purpose. The acceptance test for the whole
// port is a null test against the browser build, and the tone stack's
// coefficients are checked against the JS ones to the last few bits.

#pragma once
#include <string>

namespace ampcore {

/** Component values off the schematics. R in ohms, C in farads. */
struct Stack {
    const char* id;
    const char* name;
    double R1, R2, R3, R4, C1, C2, C3;
};

const Stack& findStack(const std::string& id);   // falls back to jcm800, as the JS does

struct Analog { double b1, b2, b3, a0, a1, a2, a3; };

/** Analogue coefficients; L is remapped because a bass pot is log taper. */
Analog analogCoeffs(const Stack& p, double t, double m, double L);

/** Exact analogue magnitude at one frequency, for testing the filter. */
double analogResponse(const Analog& c, double hz);

/** Runtime constants for the difference equation. */
struct ToneCoeffs { double g, al0, al1, be1, be2, be3, dn, nx; };

/** @param rate the rate the filter actually runs at — 4x inside the amp */
ToneCoeffs coeffs(const std::string& stack, double t, double m, double l, double rate);

/** One sample. `s` is three doubles of state, mutated in place. */
inline double toneStep(const ToneCoeffs& k, double* s, double x) {
    const double y = (k.nx * x + s[0] + k.g * (s[1] + k.g * s[2])) * k.dn;
    const double z3 = s[2] - k.g * k.al0 * y;
    const double z2 = k.g * (k.be1 * x - k.al1 * y + z3) + s[1];
    const double z1 = k.g * (k.be2 * x - y + z2) + s[0];
    s[0] = 2 * z1 - s[0];
    s[1] = 2 * z2 - s[1];
    s[2] = 2 * z3 - s[2];
    return y;
}

}  // namespace ampcore
