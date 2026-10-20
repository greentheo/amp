# Amp

A guitar amplifier that runs in a browser tab. A cascaded valve preamp, a tone
stack taken off the schematic, a push-pull power amp with sag, and a speaker
cabinet — no plugins, no installer, no assets to download.

Live: <https://greentheo.github.io/amp/>

## Why it sounds like an amp

The honest ranking, which is the opposite of what most people expect:

| Stage | Share of "sounds like an amp" |
|---|---|
| Speaker cabinet | about half |
| Tone stack | about a fifth |
| Preamp distortion | about a fifth |
| Power amp, sag, transformer | the rest |

A raw distorted preamp into a flat response is a fizzing mess, and nearly all
of that fizz lives above 5 kHz where a guitar speaker simply cannot reproduce
it. The cab is what makes distortion listenable. It is modelled here as a
rendered impulse response — an impulse plus a few cabinet panel reflections
pushed through filters in an `OfflineAudioContext` — with Axis and Distance
controls, and you can drop a measured `.wav` IR over the top at any time.

Whether the modelled cab is doing that job is now a measurement rather than
a belief, and the first answer was no: against a reference cab it was +18 to
+24 dB too bright from 3 kHz up. Fitting the filter parameters to a measured
target took that from **11.1 dB rms to 2.0**, and those fitted values are
what ships. `calibration/README.md` has the method.

The numbers in the speaker table are a fit, so they are named for each
filter's job in the chain rather than for a property of a real speaker —
`res` at 260 Hz is not a V30's free-air resonance, it is the filter that
gives the cab its low-mid body. The table is not a datasheet.

## The tone stack

This is the part you cannot fake with an EQ, and the part not to write from
memory. It is a passive RC network, so it only ever takes away — there is no
setting anywhere on any of the three controls where it has gain — and the
controls interact, which is most of why a Marshall sounds like a Marshall.

The third-order transfer function comes from D.T. Yeh and J.O. Smith's circuit
analysis, and the component values come off the schematics. Six stacks ship:
'59 Bassman, '69 Twin, JCM800, JTM45, AC30, SLO100.

`tools/test-tonestack.mjs` checks it against things that have to be true:

```
1. passive network can never have gain
   jcm800    max gain -0.02 dB   t=1 m=1 l=0 @18953Hz
2. DC is blocked — a single zero at the origin
3. the discrete filter matches the analogue response
   jcm800    worst error 0.046 dB at 8000 Hz
4. the Marshall mid scoop at noon
   scoop -8.9 dB at 696 Hz  (80Hz -2.2 dB, 6kHz -4.2 dB)
5. each control moves its own band the right way
6. stable and finite everywhere on the control grid
```

Discretised into an observable canonical form of trapezoidal integrators
rather than a direct form, for two reasons that both bite: a direct form
clusters its poles near z = 1 and falls apart in single precision, and — more
audibly — it clicks every time you touch a knob. Here the first state follows
the output, so the signal stays continuous while the controls move.

## Oversampling, and a mistake worth recording

Everything nonlinear runs at 4x inside one `AudioWorklet`. One worklet rather
than a graph of `WaveShaperNode`s, because cascaded nonlinearities have to
share an oversampled region — four shaper nodes resample four times over and
each one's distortion folds back down before it reaches the next.

The first version cornered the up/down filters just under Nyquist, at 21 kHz,
to "keep everything". That is a trap. A windowed sinc's transition band is
roughly `5.5/N` wide, so a 32-tap filter cornering at 21 kHz does not reach
its stopband until nearly 38 kHz — and the 4th through 9th harmonics of
anything in the top octave sit in that gap and fold straight back into the
audible band. Neither more taps at the same corner nor more oversampling fixes
it, because the content being folded was never above the oversampled Nyquist
to begin with.

Cornering at 11 kHz instead costs nothing and takes the worst offender from
−57 dB to −134 dB.

> **This claim used to be false, and the cab was fixed rather than the
> sentence.** Measured by differencing a cab-on and a cab-off render
> (`tools/cabcurve.mjs`), the V30 that shipped here was **15 dB** below its
> own peak at 8 kHz, and that peak sat at **5 kHz**, +12.9 dB relative to
> 1 kHz — loudest exactly where this page says fizz lives. Every speaker in
> the table had it: all five peaked between 2 and 4 kHz and were only 8.5 to
> 18 dB down at 8 kHz.
>
> Fitting the filter model to a measured reference moved the V30's peak to
> **315 Hz** and put 8 kHz **33 dB** below it, which is what the sentence
> above always claimed. The other four were corrected by the same structural
> change and now sit 24 to 39 dB down at 8 kHz, keeping their relative
> voicing. The 11 kHz corner was never in doubt — its aliasing numbers were
> measured independently — but it had been resting on a premise that was not
> true. See issue #23.

Measured, 7 kHz in at full gain, three stages, relative to the fundamental:

| Folded harmonic | Before | After |
|---|---|---|
| H4 → 20 kHz | −57 dB | **−134 dB** |
| H9 → 15 kHz | −55 dB | −77 dB |
| H5 → 13 kHz | −53 dB | −66 dB |
| H6 → 6 kHz  | −53 dB | −53 dB |
| H7 → 1 kHz  | −47 dB | −47 dB |

The remaining −47 dB is genuine deep-order saturation aliasing — products
around the 55th harmonic folding twice — and is not something a filter can
remove. The fix is antiderivative antialiasing, which is the next real piece
of work. The resampler itself was measured clean at −111 dB.

## Harmonic signature

400 Hz in, gain at 10, three stages, relative to the fundamental:

```
2nd  -34.5 dB      3rd   -8.4 dB
4th  -33.6 dB      5th  -12.0 dB
```

Strong odd harmonics with much weaker evens is what a push-pull power amp
does: the preamp's asymmetric clipping makes even harmonics and the power
stage cancels most of them. A symmetric clipper sounds like a fuzz pedal.

## Latency

`latencyHint: 'interactive'`, which is the whole difference between an amp you
can play and a thing that answers you a fifth of a second later. Input
processing is all explicitly disabled; echo cancellation in particular treats
a sustained note as feedback and ducks it.

The header reports the round trip: input capture, the graph's buffer, and the
output device, refreshed while it runs. It used to say 5.3 ms, and that was
wrong. It was read once at power-on, when Chrome still reports the output's
latency as zero, and it never counted the input at all — so it was the
graph's buffer alone. On the same machine the honest total was nearer 38 ms,
most of it the output device. Which output you play through matters more than
anything in the code, and the output picker exists partly so that difference
can be seen and chosen. Until the output has reported, the figure is shown
with a ≥ because it is a floor, not a measurement.

**Measured, not claimed.** Even the corrected readout is only what the browser
admits to. **Measure lag** plays chirps out of the chosen output, records them
back through a cable into the chosen input, and times them on the context's
own clock — the delay a note really suffers. On a MacBook with a USB DI, guitar
in through the DI and out through the MacBook's headphone jack:

| buffer | measured | browser claims |
|---|---|---|
| smallest | 35.9 ms | 13.3 ms |
| safe | 30.8 ms | 19.0 ms |

The browser under-reports by 12 to 23 ms, nearly all of it Chrome's capture
path, which delivers in 10 ms chunks and buffers them before a page ever sees
them. Nothing in JavaScript reaches it. The two buffer settings land within
about one capture chunk of each other, and which is lower varies from one
opening of the input to the next.

An amp feels tight under about 12 ms. This is roughly three times that, and
on this hardware the browser's capture path alone is most of the gap — which
is the case for a native build.

The first measurements also caught a bug. Changing the buffer rebuilt the
audio context and reattached the existing capture stream, and the audio that
arrived while the new context was being built never drained: the safe buffer
measured 73.4 ms. Reopening the input from cold after a rebuild brought the
same path to 30.8.

## The engine socket

The amp block sits between `preIn` and `preOut` in `engine.js` and nothing
either side of it knows what it is. The analytic worklet is one
implementation; a neural engine (NAM-compatible, running a captured model in a
worklet) drops into the same socket without the cab, the tone controls, the
recorder or the UI changing.

## No guitar?

There is a Karplus-Strong plucked-string generator built in, so the page makes
a noise with nothing plugged in. It is obviously synthetic on its own — its
job is to be a realistic *input* to the amp, not to pass for a player.

## Running it

```
python3 tools/serve.py 8795
```

Then <http://localhost:8795>. The dev server exists only to forbid caching;
plain `http.server` happily serves stale ES modules.

```
node tools/test-tonestack.mjs
```

## Credits

* D.T. Yeh and J.O. Smith, "Discretization of the '59 Fender Bassman Tone
  Stack", Proc. DAFx-06 — the tone stack circuit analysis.
* `faustlibraries/tonestacks.lib`, from Guitarix — the same analysis in code,
  and the schematic component values.
