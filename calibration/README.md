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
the result. Two routes:

**BIAS Amp, or any plugin** — keep it in the box. Put the stimulus on a track,
BIAS on that track, and bounce. No converters, no room, nothing to go wrong.
If you would rather run BIAS standalone, route the stimulus to it with
BlackHole and record its output back the same way.

**A real amp** — play the stimulus out of an interface output into the amp's
input (a reamp box if the levels need it), and mic the cab as you normally
would. Everything the mic and the room do becomes part of the reference,
which is the point.

Either way, do not normalise, limit, or EQ the bounce. Level is solved for
later; the shape is what is being measured.

## 3. Render ours

Power the amp on in the browser, set it where you want it, and hit **Render
the stimulus** in the CALIBRATION panel. It renders offline through the exact
graph you are listening to — about 30× faster than realtime — and when the
dev server is running it drops the file straight into `calibration/`.

Offline rather than recording the page in realtime, because a converter round
trip and whatever the OS mixer felt like doing have no business inside a
measurement whose whole purpose is to be exact.

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

The tools were checked against captures with known answers: an identical copy
shifted and attenuated reads 0.00 dB in every band and finds its offset to
within a millisecond; a one-pole low pass reads back at the right corner and
slope; and a `tanh` nonlinearity shows H3 and H5 while correctly leaving H2
and H4 at the noise floor, which is the even-versus-odd distinction that
separates a push-pull amp from a fuzz.
