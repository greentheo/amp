// Milestone 0 of the native build (#38): what round trip does a native
// app actually get on this hardware?
//
//   tools/native-lag-probe.sh --list
//   tools/native-lag-probe.sh                         # Momix in and out
//   tools/native-lag-probe.sh --out "External Headphones"
//   tools/native-lag-probe.sh --buffers 16,32,64,128
//   tools/native-lag-probe.sh --level 0               # silent: test the plumbing
//   tools/native-lag-probe.sh --selftest              # no audio at all
//
// It does what a native amp would do: one CoreAudio callback that reads the
// input and writes the output in the same cycle. It writes the same chirps
// the browser's Measure lag uses into the output, records the input on the
// same frame counter, and finds each chirp coming back through the cable by
// matched filtering. The frame gap between "written" and "heard" is the
// round trip an amp running in that callback would have — buffers, device
// latency, safety offsets and all — without trusting a single reported
// number.
//
// Where the input and output are separate devices (the Momix-Cab shows up as
// two) it builds a private aggregate device first, the way a native amp
// would have to, so the number includes that cost too.
//
// Turn the volume down and turn direct monitoring off before running it with
// a cable loop connected.

import CoreAudio
import Foundation

// ---------------------------------------------------------------- devices

func getProp<T>(_ id: AudioObjectID, _ sel: AudioObjectPropertySelector,
                _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, _ def: T) -> T {
    var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    var v = def
    var size = UInt32(MemoryLayout<T>.size)
    return AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &v) == noErr ? v : def
}

@discardableResult
func setProp<T>(_ id: AudioObjectID, _ sel: AudioObjectPropertySelector, _ value: T,
                _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> OSStatus {
    var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    var v = value
    return AudioObjectSetPropertyData(id, &addr, 0, nil, UInt32(MemoryLayout<T>.size), &v)
}

func stringProp(_ id: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String {
    var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var cf: Unmanaged<CFString>? = nil
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &cf) == noErr, let s = cf else { return "" }
    return s.takeRetainedValue() as String
}

func streamIDs(_ id: AudioObjectID, _ scope: AudioObjectPropertyScope) -> [AudioStreamID] {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
    var ids = [AudioStreamID](repeating: 0, count: Int(size) / MemoryLayout<AudioStreamID>.size)
    AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &ids)
    return ids
}

struct Device {
    let id: AudioObjectID
    let name: String
    let uid: String
    let hasIn: Bool
    let hasOut: Bool
    var rate: Double { getProp(id, kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, 0.0) }

    /// device latency + safety offset + stream latency, in frames
    func fixedLatency(_ scope: AudioObjectPropertyScope) -> UInt32 {
        let st = streamIDs(id, scope)
        guard !st.isEmpty else { return 0 }
        let lat: UInt32 = getProp(id, kAudioDevicePropertyLatency, scope, 0)
        let safe: UInt32 = getProp(id, kAudioDevicePropertySafetyOffset, scope, 0)
        let sl: UInt32 = getProp(st[0], kAudioStreamPropertyLatency, kAudioObjectPropertyScopeGlobal, 0)
        return lat + safe + sl
    }
}

func allDevices() -> [Device] {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size)
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids)
    return ids.map {
        Device(id: $0, name: stringProp($0, kAudioObjectPropertyName), uid: stringProp($0, kAudioDevicePropertyDeviceUID),
               hasIn: !streamIDs($0, kAudioObjectPropertyScopeInput).isEmpty,
               hasOut: !streamIDs($0, kAudioObjectPropertyScopeOutput).isEmpty)
    }
}

// ---------------------------------------------------------------- the chirp

/// 12 ms log chirp, 600 Hz to 9 kHz, Hann windowed — identical to the
/// browser's Measure lag, so the two measure the same thing.
func chirp(rate: Double) -> [Float] {
    let n = Int((0.012 * rate).rounded())
    let f0 = 600.0, f1 = 9000.0, T = Double(n) / rate, k = log(f1 / f0)
    return (0..<n).map { i in
        let t = Double(i) / rate
        let ph = (2 * Double.pi * f0 * T / k) * (exp(t / T * k) - 1)
        return Float(sin(ph) * (0.5 - 0.5 * cos(2 * Double.pi * Double(i) / Double(n - 1))))
    }
}

struct Found { let delayFrames: Double; let snr: Double }
struct Arrival { let delayFrames: Double; let strength: Double }

/// Find each chirp in the recording by matched filtering, refined to a
/// fraction of a frame with a parabola through the peak.
///
/// Latency is the EARLIEST strong arrival, not the strongest. The first
/// version took the strongest, and the first real run reported 249 ms with a
/// slope across buffer sizes that matched CoreAudio's prediction exactly — a
/// constant quarter of a second from somewhere outside the probe. If a
/// second path (another app hearing the chirp and playing it back, say) is
/// louder than the direct one, "strongest" reports the second path. So every
/// strong arrival of the first chirp is listed, and the earliest is used.
func analyse(rec: [Float], starts: [Int], tpl: [Float], rate: Double) -> (found: [Found], peak: Float, arrivals: [Arrival]) {
    let tl = tpl.count
    var peakAbs: Float = 0
    for v in rec { peakAbs = max(peakAbs, abs(v)) }
    func corr(_ j: Int) -> Double {
        if j < 0 || j + tl > rec.count { return 0 }
        var a = 0.0
        for i in 0..<tl { a += Double(rec[j + i]) * Double(tpl[i]) }
        return abs(a)
    }
    func peak(_ lo: Int, _ hi: Int) -> (at: Double, snr: Double)? {
        let lo = max(0, lo), hi = min(rec.count - tl, hi)
        guard hi > lo else { return nil }
        var best = -1.0, at = lo
        var mags: [Double] = []
        mags.reserveCapacity(hi - lo)
        for j in lo..<hi { let v = corr(j); mags.append(v); if v > best { best = v; at = j } }
        let a = corr(at - 1), c = corr(at + 1), den = a - 2 * best + c
        let frac = den != 0 ? 0.5 * (a - c) / den : 0
        mags.sort()
        let floor = max(mags[mags.count / 2], 1e-12)
        return (Double(at) + frac, best / floor)
    }
    var out: [Found] = []
    // Every strong arrival of the first chirp: local maxima of the matched
    // filter above a fifth of the strongest and well clear of the noise.
    // Start a little before the chirp, so a peak right at zero delay sits
    // inside the window rather than on its edge, where it cannot be a maximum.
    let lo = max(0, starts[0] - 32), hi = min(rec.count - tl, starts[0] + Int(0.35 * rate))
    guard hi > lo else { return ([], peakAbs, []) }
    var mags = [Double](repeating: 0, count: hi - lo)
    for j in lo..<hi { mags[j - lo] = corr(j) }
    let sorted = mags.sorted()
    let floor = max(sorted[sorted.count / 2], 1e-12)
    let top = sorted.last ?? 0
    var arrivals: [Arrival] = []
    let sep = Int(0.001 * rate)
    var j = 1
    while j < mags.count - 1 {
        let v = mags[j]
        if v >= top * 0.2 && v >= floor * 8 && v >= mags[j - 1] && v >= mags[j + 1] {
            // Keep only the biggest peak within a millisecond, so the
            // ringing of one arrival is not counted as several.
            var bj = j
            var k = j + 1
            while k < min(mags.count, j + sep) { if mags[k] > mags[bj] { bj = k }; k += 1 }
            arrivals.append(Arrival(delayFrames: Double(lo + bj - starts[0]), strength: mags[bj] / floor))
            j = bj + sep
        } else {
            j += 1
        }
    }
    // Strengths relative to the strongest, for the report.
    arrivals = arrivals.map { Arrival(delayFrames: $0.delayFrames, strength: $0.strength * floor / top) }
    guard let earliest = arrivals.first else { return ([], peakAbs, arrivals) }
    // Refine the earliest to a fraction of a frame. Its SNR comes from the
    // wide window's noise floor: judged against only the few samples around
    // the peak, every peak looks like noise.
    let at = starts[0] + Int(earliest.delayFrames)
    let a = corr(at - 1), b = corr(at), c = corr(at + 1), den = a - 2 * b + c
    let frac = den != 0 ? 0.5 * (a - c) / den : 0
    // The first chirp is searched for widely; once its delay is known the
    // rest are looked for in a narrow window around where it says they are.
    let d0 = Double(at - starts[0]) + frac
    out.append(Found(delayFrames: d0, snr: b / floor))
    for s in starts.dropFirst() {
        let expect = s + Int(d0.rounded())
        if let p = peak(expect - Int(0.004 * rate), expect + Int(0.004 * rate)) {
            out.append(Found(delayFrames: p.at - Double(s), snr: p.snr))
        }
    }
    return (out, peakAbs, arrivals)
}

// ---------------------------------------------------------------- running

func makeAggregate(input: Device, output: Device, drift: Bool) -> AudioObjectID? {
    // Literal keys rather than the kAudioAggregate* macros, which Swift does
    // not reliably import.
    let desc: [String: Any] = [
        "name": "amp-lag-probe",
        "uid": "com.greentheo.amp.lagprobe.\(UUID().uuidString)",
        "private": 1,
        "master": output.uid,
        "subdevices": [
            ["uid": output.uid],
            ["uid": input.uid, "drift": drift ? 1 : 0],
        ],
    ]
    var agg = AudioObjectID(0)
    let st = AudioHardwareCreateAggregateDevice(desc as CFDictionary, &agg)
    guard st == noErr, agg != 0 else { return nil }
    // A new aggregate takes a moment to come up before it will take settings.
    Thread.sleep(forTimeInterval: 0.6)
    return agg
}

struct Run {
    let buffer: UInt32
    let found: [Found]
    let peak: Float
    let overloads: Int
    let actualBuffer: UInt32
    let arrivals: [Arrival]
}

func run(device: AudioObjectID, buffer: UInt32, rate: Double, level: Float) -> Run {
    setProp(device, kAudioDevicePropertyBufferFrameSize, buffer)
    Thread.sleep(forTimeInterval: 0.2)
    let actual: UInt32 = getProp(device, kAudioDevicePropertyBufferFrameSize, kAudioObjectPropertyScopeGlobal, 0)

    let tpl = chirp(rate: rate)
    let chirps = 5, gap = Int(0.4 * rate), lead = Int(0.5 * rate)
    let starts = (0..<chirps).map { lead + $0 * gap }
    let total = lead + chirps * gap + Int(0.5 * rate)

    // Everything the callback touches is allocated here, before it starts:
    // the IO thread must not allocate, lock or wait.
    let rec = UnsafeMutablePointer<Float>.allocate(capacity: total)
    rec.initialize(repeating: 0, count: total)
    let sig = UnsafeMutablePointer<Float>.allocate(capacity: total)
    sig.initialize(repeating: 0, count: total)
    for s in starts { for i in 0..<tpl.count { sig[s + i] = tpl[i] * level } }
    let clock = UnsafeMutablePointer<Int>.allocate(capacity: 1)
    clock.pointee = 0

    var overloads = 0
    var oaddr = AudioObjectPropertyAddress(mSelector: kAudioDeviceProcessorOverload, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    let listener: AudioObjectPropertyListenerBlock = { _, _ in overloads += 1 }
    AudioObjectAddPropertyListenerBlock(device, &oaddr, nil, listener)

    var proc: AudioDeviceIOProcID?
    AudioDeviceCreateIOProcIDWithBlock(&proc, device, nil) { _, inInput, _, outOutput, _ in
        let outs = UnsafeMutableAudioBufferListPointer(outOutput)
        let ins = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInput))
        // Frames this cycle, from the first output buffer.
        guard let ob = outs.first, ob.mNumberChannels > 0 else { return }
        let frames = Int(ob.mDataByteSize) / (4 * Int(ob.mNumberChannels))
        let t = clock.pointee
        // Same frame counter for both directions: read input frame t, write
        // output frame t, exactly as an amp in this callback would.
        if let ib = ins.first, let src = ib.mData?.assumingMemoryBound(to: Float.self), ib.mNumberChannels > 0 {
            let ch = Int(ib.mNumberChannels)
            for f in 0..<frames where t + f < total { rec[t + f] = src[f * ch] }
        }
        for b in outs {
            guard let dst = b.mData?.assumingMemoryBound(to: Float.self) else { continue }
            let ch = Int(b.mNumberChannels)
            for f in 0..<frames {
                let v: Float = t + f < total ? sig[t + f] : 0
                for c in 0..<ch { dst[f * ch + c] = v }
            }
        }
        clock.pointee = t + frames
    }
    guard let p = proc else { fatalError("could not create an IO proc on that device") }
    AudioDeviceStart(device, p)
    let deadline = Date().addingTimeInterval(Double(total) / rate + 3)
    while clock.pointee < total && Date() < deadline { Thread.sleep(forTimeInterval: 0.02) }
    AudioDeviceStop(device, p)
    AudioDeviceDestroyIOProcID(device, p)
    AudioObjectRemovePropertyListenerBlock(device, &oaddr, nil, listener)

    let recorded = Array(UnsafeBufferPointer(start: rec, count: min(total, clock.pointee)))
    rec.deallocate(); sig.deallocate(); clock.deallocate()
    let (found, peak, arrivals) = analyse(rec: recorded, starts: starts, tpl: tpl, rate: rate)
    return Run(buffer: buffer, found: found, peak: peak, overloads: overloads, actualBuffer: actual, arrivals: arrivals)
}

// ---------------------------------------------------------------- main

var args = Array(CommandLine.arguments.dropFirst())
func opt(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

if args.contains("--selftest") {
    // The timing maths on its own, against delays that are known exactly.
    let rate = 48000.0, tpl = chirp(rate: rate)
    let starts = (0..<5).map { Int(0.5 * rate) + $0 * Int(0.4 * rate) }
    var ok = true
    for trueFrames in [0, 1, 157, 403, 2400] {
        var rec = [Float](repeating: 0, count: starts.last! + Int(0.9 * rate))
        var seed: UInt32 = 1
        for i in rec.indices { seed = seed &* 1664525 &+ 1013904223; rec[i] = (Float(seed >> 8) / 16777216 - 0.5) * 0.002 }
        for s in starts { for i in 0..<tpl.count { rec[s + trueFrames + i] += tpl[i] * 0.3 } }
        let (found, _, _) = analyse(rec: rec, starts: starts, tpl: tpl, rate: rate)
        let d = found.map { $0.delayFrames }
        let err = d.map { abs($0 - Double(trueFrames)) }.max() ?? .infinity
        print(String(format: "  true %5d frames  measured %8.3f  worst error %.3f frames  (%d chirps)", trueFrames, d.first ?? -1, err, d.count))
        if err > 0.05 || d.count != 5 { ok = false }
    }
    // The case that fooled the first version: a direct return, then a
    // louder second path. The answer must be the direct one.
    do {
        var rec = [Float](repeating: 0, count: starts.last! + Int(0.9 * rate))
        for s in starts { for i in 0..<tpl.count {
            rec[s + 340 + i] += tpl[i] * 0.1          // direct, 7.08 ms
            rec[s + 11950 + i] += tpl[i] * 0.3        // louder, 249 ms later path
        } }
        let (found, _, arr) = analyse(rec: rec, starts: starts, tpl: tpl, rate: rate)
        let got = found.first?.delayFrames ?? -1
        let pass = abs(got - 340) < 0.05 && arr.count == 2
        print(String(format: "  direct 340 + louder 11950: measured %8.3f frames, %d arrivals listed  %@",
                     got, arr.count, pass ? "ok" : "WRONG"))
        if !pass { ok = false }
    }
    print(ok ? "selftest passed" : "SELFTEST FAILED")
    exit(ok ? 0 : 1)
}

let devs = allDevices()
if args.contains("--list") {
    for d in devs {
        let dirs = [d.hasIn ? "in" : nil, d.hasOut ? "out" : nil].compactMap { $0 }.joined(separator: "+")
        print(String(format: "  %-28@ %-7@ %6.0f Hz   in %4d  out %4d frames fixed   uid %@",
                     d.name as NSString, dirs as NSString, d.rate,
                     d.fixedLatency(kAudioObjectPropertyScopeInput), d.fixedLatency(kAudioObjectPropertyScopeOutput), d.uid as NSString))
    }
    exit(0)
}

let inName = opt("--in") ?? "Momix"
let outName = opt("--out") ?? inName
let buffers = (opt("--buffers") ?? "32,64,128,256").split(separator: ",").compactMap { UInt32($0) }
let level = Float(opt("--level") ?? "0.3") ?? 0.3
let drift = !args.contains("--no-drift")

guard let input = devs.first(where: { $0.hasIn && $0.name.localizedCaseInsensitiveContains(inName) }) else {
    print("no input device matching \"\(inName)\" — try --list"); exit(1)
}
guard let output = devs.first(where: { $0.hasOut && $0.name.localizedCaseInsensitiveContains(outName) }) else {
    print("no output device matching \"\(outName)\" — try --list"); exit(1)
}

let rate = output.rate
if input.rate != rate {
    print("input runs at \(input.rate) Hz and output at \(rate) Hz — set them to the same rate in Audio MIDI Setup first")
    exit(1)
}

var device = output.id
var aggregate: AudioObjectID? = nil
if input.id != output.id {
    guard let agg = makeAggregate(input: input, output: output, drift: drift) else {
        print("could not build an aggregate of \(input.name) and \(output.name)"); exit(1)
    }
    aggregate = agg
    device = agg
}
// Fixed latency: what CoreAudio reports for the pair, before buffers. For an
// aggregate, ask the parts — the aggregate's own figures fold in its drift
// compensation in ways that differ by macOS version.
let fixedIn = input.fixedLatency(kAudioObjectPropertyScopeInput)
let fixedOut = output.fixedLatency(kAudioObjectPropertyScopeOutput)
let originalBuffer: UInt32 = getProp(device, kAudioDevicePropertyBufferFrameSize, kAudioObjectPropertyScopeGlobal, 0)

print("in  \(input.name)\nout \(output.name)\(aggregate != nil ? "   (private aggregate\(drift ? ", drift-corrected" : ", no drift correction"))" : "")")
// Another app holding the same devices can hear the chirps and play them
// back into the loop, which shows up as a second arrival.
for d in [input, output] where (getProp(d.id, kAudioDevicePropertyDeviceIsRunningSomewhere, kAudioObjectPropertyScopeGlobal, UInt32(0)) != 0) {
    print("⚠  \(d.name) (\(d.hasIn ? "in" : "out")) is already in use by another app — quit it (Chrome?) or it may add a second path to the loop")
}
print(String(format: "%.0f Hz, reported fixed latency %d in + %d out frames", rate, fixedIn, fixedOut))
print("\nTurn the volume down and direct monitoring off. Starting in 2 s…\n")
Thread.sleep(forTimeInterval: 2)

print(" buffer   measured    spread   predicted   snr   glitches")
var rows: [(UInt32, Double)] = []
for b in buffers {
    let r = run(device: device, buffer: b, rate: rate, level: level)
    let predicted = Double(fixedIn + fixedOut + 2 * r.actualBuffer) / rate * 1000
    if r.found.isEmpty {
        let why = r.peak < 0.002 ? "nothing reached the input" : String(format: "no clear chirp (input peaked at %.3f)", r.peak)
        print(String(format: "%5d    —  %@  — check the cable, the volume and the input   glitches %d", r.actualBuffer, why as NSString, r.overloads))
        continue
    }
    let ms = r.found.map { $0.delayFrames / rate * 1000 }.sorted()
    let med = ms[ms.count / 2], spread = ms.last! - ms.first!
    let snr = r.found.map { $0.snr }.min() ?? 0
    var note = r.actualBuffer != b ? "  (asked \(b), got \(r.actualBuffer))" : ""
    if r.peak > 0.98 { note += "  CLIPPED — turn it down" }
    print(String(format: "%5d   %7.2f ms  %6.2f ms  %7.2f ms  %5.0f   %4d%@", r.actualBuffer, med, spread, predicted, snr, r.overloads, note as NSString))
    if r.arrivals.count > 1 {
        let list = r.arrivals.map { String(format: "%.1f ms (%.0f%%)", $0.delayFrames / rate * 1000, $0.strength * 100) }.joined(separator: ", ")
        print("         heard it \(r.arrivals.count) times: \(list) — the first is the latency, the rest are other paths")
    }
    rows.append((r.actualBuffer, med))
}

setProp(device, kAudioDevicePropertyBufferFrameSize, originalBuffer)
if let agg = aggregate { AudioHardwareDestroyAggregateDevice(agg) }

if let best = rows.min(by: { $0.1 < $1.1 }) {
    print(String(format: "\nbest: %.1f ms at %d frames.  The browser measured 31-36 ms on this hardware.", best.1, best.0))
    print("Under ~12 ms plays like an amp. Use the smallest buffer with no glitches.")
}
