# Calibration

Matching this amp against a real one, against BIAS Amp, and against the
Positive Grid models — with numbers rather than memory.

Tone memory is about ten seconds long. A/B-ing two amps across two sessions,
at two different levels, through two different output paths tells you almost
nothing, which is why "does it sound right?" has stayed a known unknown. The
way out is to drive both with an identical file and measure the recordings.

## What you need to provide

**A dry DI clip of your own playing.** Everything else here is generated.

* Guitar straight into the interface. No amp sim, no pedals, no EQ, no
  compressor, no reverb — if BIAS is in the path, it is the wrong file.
* 15 to 30 seconds. Longer gets trimmed to 30.
* Worth including, because each one stresses a different part of the amp:
  * single notes low on the neck, then high
  * an open chord, strummed
  * palm mutes
  * one note bent and held, to show sustain and sag
  * one chord hit hard and left to ring
* Peaks around −6 to −12 dBFS. Not clipped. Quiet is fine and gets
  normalised; clipped cannot be undone.
* WAV, any sample rate and bit depth — it gets resampled and summed to mono.

Drop it in `calibration/di/`.

### If you have not recorded one yet

```bash
node tools/fetch-di.mjs
```

That pulls FreePats *Electric Guitar FSBS (direct)* — a Fender recorded
straight into an instrument input, 24-bit/48 kHz, released under **CC0 1.0**
— and assembles a 26-second reference phrase into
`calibration/di/freepats-cc0-reference.wav`. Public domain, so it can live in
a public project's workflow without anyone having to think about it.

Be clear about what it is. The source is a sampled instrument: single notes,
each left to ring. The *tone* is real — real pickup, real strings, real DI,
real decay, and it shows: the low E comes back with its second harmonic 4.8 dB
**above** the fundamental, which is what a bridge pickup on an 82 Hz string
actually does and what no synthesised DI will give you. But the *performance*
is assembled by the script. Chords are real notes layered at strum offsets
rather than six strings struck together, and there are no palm mutes, because
a palm mute is a different timbre and not a shorter note — faking one would
put a lie into the reference.

A good stand-in and a bad substitute.

The synthetic sections measure the amp. Your clip is what tells you whether
the measurements were the ones that mattered, and it is the only section that
will mean anything when you listen to the two captures back to back.

## 1. Build the stimulus

```bash
node tools/stimulus.mjs --di calibration/di/your-clip.wav
```

That writes `calibration/stimulus.wav` and a `stimulus.json` describing where
every section starts. The sections are chosen so each one isolates a block:

| Section | What it measures |
|---|---|
| sweep at −30 dBFS | the linear response: cab and tone stack, preamp barely working |
| sweep at −12 dBFS | the same response with everything driven — a different curve, and that difference *is* the amp |
| tones, 4 pitches × 4 levels | the harmonic series, which is the preamp's signature and the one thing an EQ cannot fake |
| struck chord, left to ring | sag and compression |
| Karplus-Strong riff | a musical reference that is identical between runs |
| your DI | real playing |

Levels matter more than anything else here. An amp is nonlinear, so its
response at −30 dBFS and at −6 dBFS are two different responses, and a
calibration done at one level is worth very little at the other.

## 2. Capture the reference

Play `calibration/stimulus.wav` through whatever you are matching and record
the result, without normalising, limiting or EQ'ing the bounce. Level is
solved for later; the shape is what is being measured.

### BIAS AMP 2 in Ableton (the route to prefer)

Needs the BIAS AMP 2 **plugin** (AU or VST3), not just the standalone app. If
only the standalone is installed, re-run the Positive Grid installer and tick
the plugin formats.

Everything stays in the box: no converters, no clock, no room, and the bounce
is exact.

1. **Preferences -> Audio -> Sample Rate: 48000.** The compare tool handles a
   mismatch, but there is no reason to add a resample.
2. New set. Drag `calibration/stimulus.wav` onto an audio track.
3. **Turn Warp OFF on the clip.** This is the one that silently ruins the
   measurement. Live auto-warps long imports, and a warped clip is
   time-stretched — every section lands somewhere other than where the
   manifest says it does. Select the clip, Clip view, Warp switch off.
4. Clip Gain at 0 dB, track volume at unity, no other devices on the track.
5. Drop BIAS AMP 2 on the track. Pick the amp model you want to match and
   **turn its reverb and noise gate off** — they are not part of what is
   being compared, and a gate chews the quiet end of the sweep.
6. Nothing on the master chain. No limiter, no compressor, no EQ.
7. Select the whole arrangement, then **Export Audio/Video**:
   * Rendered Track: Master
   * Sample Rate 48000, Encode PCM, File Type WAV, Bit Depth 24
   * **Normalize: Off**, Dither: None
8. Save it into `calibration/` as something you will recognise, e.g.
   `bias-jcm800.wav`.

### Standalone BIAS AMP 2, with a loopback

Only if the plugin is not an option. Needs two virtual devices, because one
carries the stimulus in and the other carries BIAS's output back out:

```bash
brew install --cask blackhole-2ch blackhole-16ch
```

Then set BIAS AMP 2's input to BlackHole 2ch and its output to BlackHole
16ch, play the stimulus out of BlackHole 2ch, and record BlackHole 16ch in
Ableton. It works, but there are more places for a sample rate or a clock to
go quietly wrong, which is why the plugin route is the one to prefer.

### A real amp

Play the stimulus out of an interface output into the amp's input — a reamp
box if the levels need it — and mic the cab as you normally would. Everything
the mic and the room do becomes part of the reference, which is the point.

### Set this amp to match

The comparison is only fair if both sides are doing the same job, so before
rendering:

* **Reverb to 0.** BIAS's reverb is off, so this one has to be too.
* **Gate low**, for the same reason it is off in BIAS: it eats the quiet
  end of the sweep and the tail of the decay.
* Pick the tone stack from the same family as the BIAS model — matching a
  JCM800 against the Twin stack measures the difference between two
  different amps, which is true but not useful.

## 3. Render ours

Power the amp on in the browser, set it where you want it, and hit **Render
the stimulus** in the CALIBRATION panel. It renders offline through the exact
graph you are listening to — about 30× faster than realtime — and when the
dev server is running it drops the file straight into `calibration/`.

Offline rather than recording the page in realtime, because a converter round
trip and whatever the OS mixer felt like doing have no business inside a
measurement whose whole purpose is to be exact.

## Fitting the cab

The cab is the one block that does not need searching, because it is linear
and it is last in the chain. So `Y_with_cab = cab x Y_without_cab` at every
frequency, whatever the preamp did upstream — divide one spectrum by the
other and the amp, its distortion and its settings all cancel, leaving the
cab's own response.

```bash
tools/bias.sh --amp "British Lead 800" --set gain=0.6 --out calibration/bias.wav
tools/bias.sh --amp "British Lead 800" --set gain=0.6 --no-cab --out calibration/bias-nocab.wav
node tools/cabcurve.mjs calibration/bias.wav calibration/bias-nocab.wav --out calibration/cab-target.json
```

That prints the curve and writes a 24-point target. The check that it worked
is in the output: the two sweep sections are at different drive levels, and a
linear block must answer the same to both. They agree to 0.01–0.17 dB in
practice. If they do not, something upstream is level dependent and the
measurement is not a cab response.

Then fit, in the page console:

```js
await window.amp.fitCab('calibration/cab-target.json', { passes: 14 })
```

About a second, because scoring a candidate means rendering a 90 ms impulse
and reading its spectrum — not rendering 78 seconds of stimulus. Thousands of
evaluations instead of a grid of twenty.

Always confirm the fit against a real render rather than trusting the number
it reports — render with `cabMix:1` and `cabMix:0` and run `cabcurve.mjs` on
the pair. Prediction and measurement agree to about 0.2 dB. They did not at
first: the cab had `Math.random()` noise in its impulse, so every evaluation
saw a slightly different speaker, and the optimiser chased the noise and
stopped on a lucky draw — reporting 2.59 dB where a render measured 4.13.
The noise is seeded now.

**What this is not.** It produces a 24-point curve to fit our own filter
model against, which is ordinary calibration. Deriving and shipping someone
else's impulse response would be a different thing and is not what this does.

## 4. Compare

```bash
node tools/compare.mjs calibration/amp-jcm800-*.wav calibration/bias-jcm800.wav
```

Neither file has to start at the same moment, sit at the same level, or even
share a sample rate — all three are solved for. The alignment works on the
dB-domain energy envelope, which survives any amount of distortion.

## Reading the output

The value is in *which* measurement is off:

| What is off | Where to look |
|---|---|
| a broad tilt across the spectrum | the cab |
| a bump or scoop in one region | the tone stack |
| spectrum right, harmonic ratios wrong | the preamp — triode asymmetry, stage count |
| harmonics right, decay wrong | sag, the gate, the power supply |
| only the real-playing section differs | the difference lives where the guitar lives |

Two numbers are worth more than the rest. **How the response moves with
drive** is the difference between the two sweep curves: two amps can share a
frequency response and still feel nothing alike, and that is where it shows.
**Crest factor** on the real-playing section is how much of your picking
survived — an amp that measures the same on a sweep can still squash the
playing.

A low correlation on the alignment line means the stimulus was not found:
usually the capture is of something else, is heavily gated, or is missing its
first few seconds.

## Sanity

The tools were checked against captures with known answers:

* an identical copy, shifted 0.731 s and cut 6 dB, reads **0.00 dB in every
  band**, recovers the level offset as exactly −6.0 dB, and finds its shift to
  the millisecond
* a one-pole low pass at 2.5 kHz reads back at the right corner and slope
* a `tanh` nonlinearity shows H3 and H5 and correctly leaves H2 and H4 at the
  noise floor — the even-versus-odd distinction that separates a push-pull amp
  from a fuzz
* a 44.1 kHz capture compared against a 48 kHz render aligns to within 4 ms of
  the chain's measured 7 ms delay

That last one was a bug before it was a test. Binning both envelopes by
sample count rather than by duration put a 44.1 kHz bounce and a 48 kHz render
on time scales 9% apart, and they correlated against nothing — which is the
ordinary case, since DAWs bounce at 44.1 all the time.

Alignment locks onto the marker rather than the whole file. Correlating
everything sounds more robust and is not: two thirds of the stimulus is long
smooth sweeps whose envelope barely moves over tens of milliseconds, so the
peak sits on a plateau that the gate and the cab tilt. Whole-file alignment
put a render whose true delay was 7 ms at −70 ms. The marker is three sharp
bursts in silence and gives one unambiguous peak.
