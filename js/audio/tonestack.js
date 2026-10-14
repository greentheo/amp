// The passive treble/middle/bass network that sits between the preamp stages.
//
// This is the part of an amp you cannot fake with an EQ. It is a passive RC
// network, so it only ever takes away — there is no setting where it has gain
// — and its three controls interact: turning the treble down on a Marshall
// moves where the midrange scoop sits. That interaction is most of why a
// Marshall sounds like a Marshall and a Fender does not.
//
// The transfer function is third order:
//
//   H(s) = (b3 s^3 + b2 s^2 + b1 s) / (a3 s^3 + a2 s^2 + a1 s + 1)
//
// with the coefficients below written in terms of the pot positions and the
// component values off the schematic. There is no constant term in the
// numerator, which is the network being AC-coupled: H(0) = 0, always.
//
// Sources, because this is not something to derive from memory:
//   D.T. Yeh and J.O. Smith, "Discretization of the '59 Fender Bassman Tone
//     Stack", Proc. DAFx-06 — the circuit analysis these coefficients come from.
//   faustlibraries/tonestacks.lib (from Guitarix) — the same analysis in code,
//     and the schematic component values below.

/** Component values off the schematics. R in ohms, C in farads. */
export const STACKS = {
  bassman:  { name: "Fender '59 Bassman",  R1: 250e3, R2: 1e6,   R3: 25e3, R4: 56e3,  C1: 250e-12, C2: 20e-9,  C3: 20e-9 },
  twin:     { name: "Fender '69 Twin",     R1: 250e3, R2: 250e3, R3: 10e3, R4: 100e3, C1: 120e-12, C2: 100e-9, C3: 47e-9 },
  jcm800:   { name: 'Marshall JCM800',     R1: 220e3, R2: 1e6,   R3: 22e3, R4: 33e3,  C1: 470e-12, C2: 22e-9,  C3: 22e-9 },
  jtm45:    { name: 'Marshall JTM45',      R1: 250e3, R2: 1e6,   R3: 25e3, R4: 33e3,  C1: 270e-12, C2: 22e-9,  C3: 22e-9 },
  ac30:     { name: 'Vox AC30',            R1: 1e6,   R2: 1e6,   R3: 10e3, R4: 100e3, C1: 50e-12,  C2: 22e-9,  C3: 22e-9 },
  soldano:  { name: 'Soldano SLO100',      R1: 250e3, R2: 1e6,   R3: 25e3, R4: 47e3,  C1: 470e-12, C2: 20e-9,  C3: 20e-9 },
};

/**
 * Analogue coefficients for one setting of the three controls.
 * @param {object} p component values
 * @param {number} t treble 0..1
 * @param {number} m middle 0..1
 * @param {number} L bass 0..1 — remapped below, because a bass pot is log taper
 */
export function analogCoeffs(p, t, m, L) {
  const { R1, R2, R3, R4, C1, C2, C3 } = p;
  const l = Math.exp((L - 1) * 3.4);

  const b1 = t * C1 * R1 + m * C3 * R3 + l * (C1 * R2 + C2 * R2) + (C1 * R3 + C2 * R3);

  const b2 = t * (C1 * C2 * R1 * R4 + C1 * C3 * R1 * R4)
    - m * m * (C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3)
    + m * (C1 * C3 * R1 * R3 + C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3)
    + l * (C1 * C2 * R1 * R2 + C1 * C2 * R2 * R4 + C1 * C3 * R2 * R4)
    + l * m * (C1 * C3 * R2 * R3 + C2 * C3 * R2 * R3)
    + (C1 * C2 * R1 * R3 + C1 * C2 * R3 * R4 + C1 * C3 * R3 * R4);

  const b3 = l * m * (C1 * C2 * C3 * R1 * R2 * R3 + C1 * C2 * C3 * R2 * R3 * R4)
    - m * m * (C1 * C2 * C3 * R1 * R3 * R3 + C1 * C2 * C3 * R3 * R3 * R4)
    + m * (C1 * C2 * C3 * R1 * R3 * R3 + C1 * C2 * C3 * R3 * R3 * R4)
    + t * C1 * C2 * C3 * R1 * R3 * R4 - t * m * C1 * C2 * C3 * R1 * R3 * R4
    + t * l * C1 * C2 * C3 * R1 * R2 * R4;

  const a0 = 1;

  const a1 = (C1 * R1 + C1 * R3 + C2 * R3 + C2 * R4 + C3 * R4)
    + m * C3 * R3 + l * (C1 * R2 + C2 * R2);

  const a2 = m * (C1 * C3 * R1 * R3 - C2 * C3 * R3 * R4 + C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3)
    + l * m * (C1 * C3 * R2 * R3 + C2 * C3 * R2 * R3)
    - m * m * (C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3)
    + l * (C1 * C2 * R2 * R4 + C1 * C2 * R1 * R2 + C1 * C3 * R2 * R4 + C2 * C3 * R2 * R4)
    + (C1 * C2 * R1 * R4 + C1 * C3 * R1 * R4 + C1 * C2 * R3 * R4 + C1 * C2 * R1 * R3
       + C1 * C3 * R3 * R4 + C2 * C3 * R3 * R4);

  const a3 = l * m * (C1 * C2 * C3 * R1 * R2 * R3 + C1 * C2 * C3 * R2 * R3 * R4)
    - m * m * (C1 * C2 * C3 * R1 * R3 * R3 + C1 * C2 * C3 * R3 * R3 * R4)
    + m * (C1 * C2 * C3 * R3 * R3 * R4 + C1 * C2 * C3 * R1 * R3 * R3 - C1 * C2 * C3 * R1 * R3 * R4)
    + l * C1 * C2 * C3 * R1 * R2 * R4
    + C1 * C2 * C3 * R1 * R3 * R4;

  return { b1, b2, b3, a0, a1, a2, a3 };
}

/** Exact analogue response at one frequency, for testing against the filter. */
export function analogResponse(c, hz) {
  const w = 2 * Math.PI * hz;
  // s = jw, so s^2 = -w^2 and s^3 = -jw^3.
  const nRe = -c.b2 * w * w;
  const nIm = c.b1 * w - c.b3 * w * w * w;
  const dRe = c.a0 - c.a2 * w * w;
  const dIm = c.a1 * w - c.a3 * w * w * w;
  const den = dRe * dRe + dIm * dIm;
  const re = (nRe * dRe + nIm * dIm) / den;
  const im = (nIm * dRe - nRe * dIm) / den;
  return Math.hypot(re, im);
}

/**
 * Runtime constants for the difference equation.
 *
 * Discretised by bilinear transform into an observable canonical form of
 * trapezoidal integrators rather than a direct form. Two reasons, both of
 * which bite in practice: a direct form clusters its poles near z = 1 and
 * falls apart in single precision at high sample rates, and — more audibly —
 * the first state here follows the output, so the signal stays continuous
 * when a knob moves the numerator and denominator together. A direct form
 * clicks every time you touch the tone controls.
 *
 * @param {number} rate the rate the filter will actually run at (4x here)
 */
export function coeffs(stack, t, m, l, rate) {
  const c = analogCoeffs(STACKS[stack] || STACKS.jcm800, t, m, l);
  const r2 = 1 / c.a2;
  const r3 = 1 / c.a3;
  const rw = c.a3 * r2;                 // 1/w, where w = a2/a3
  const g = c.a2 * r3 * 0.5 / rate;     // w / 2fs
  const al1 = c.a1 * r2 * rw;
  const al0 = c.a0 * r2 * rw * rw;
  const be3 = c.b3 * r3;
  const be2 = c.b2 * r2;
  const be1 = c.b1 * r2 * rw;
  const dn = 1 / (1 + g * (1 + g * (al1 + g * al0)));
  const nx = be3 + g * (be2 + g * be1);
  return { g, al0, al1, be1, be2, be3, dn, nx };
}

/** One sample. `s` is a 3-element state array, mutated in place. */
export function step(k, s, x) {
  const y = (k.nx * x + s[0] + k.g * (s[1] + k.g * s[2])) * k.dn;
  const z3 = s[2] - k.g * k.al0 * y;
  const z2 = k.g * (k.be1 * x - k.al1 * y + z3) + s[1];
  const z1 = k.g * (k.be2 * x - y + z2) + s[0];
  s[0] = 2 * z1 - s[0];
  s[1] = 2 * z2 - s[1];
  s[2] = 2 * z3 - s[2];
  return y;
}
