// What CoreAudio says each audio device's own latency is, with no browser
// in the way.
//
//   swift tools/coreaudio-latency.swift
//
// A native app's round trip is roughly
//
//   input (device + safety offset + stream latency + buffer)
//   + output (device + safety offset + stream latency + buffer)
//
// so this is the floor a native build could reach on this hardware, before
// writing any of it. On a MacBook with a Momix-Cab USB DI it said 3.25 ms in
// and 2.52 ms out, with buffers allowed down to 15 frames: about 8.4 ms round
// trip at 64 frames, where Chrome measured 31-36 ms through the same cables.
// It also showed the MacBook's built-in mic and speakers carrying 31 ms and
// 17 ms of their own processing, which is why they make a poor test loop.
import CoreAudio
import Foundation

func prop<T>(_ id: AudioObjectID, _ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope, _ def: T) -> T {
    var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    var v = def
    var size = UInt32(MemoryLayout<T>.size)
    let st = AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &v)
    return st == noErr ? v : def
}
func name(_ id: AudioObjectID) -> String {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var cf: Unmanaged<CFString>? = nil
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &cf) == noErr, let s = cf else { return "?" }
    return s.takeRetainedValue() as String
}
func streams(_ id: AudioObjectID, _ scope: AudioObjectPropertyScope) -> [AudioStreamID] {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
    var ids = [AudioStreamID](repeating: 0, count: Int(size) / MemoryLayout<AudioStreamID>.size)
    AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &ids)
    return ids
}
func side(_ id: AudioObjectID, _ scope: AudioObjectPropertyScope) -> (lat: UInt32, safe: UInt32, stream: UInt32)? {
    let st = streams(id, scope)
    if st.isEmpty { return nil }
    let lat: UInt32 = prop(id, kAudioDevicePropertyLatency, scope, 0)
    let safe: UInt32 = prop(id, kAudioDevicePropertySafetyOffset, scope, 0)
    let sl: UInt32 = prop(st[0], kAudioStreamPropertyLatency, kAudioObjectPropertyScopeGlobal, 0)
    return (lat, safe, sl)
}

var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
var size: UInt32 = 0
AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size)
var devs = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &devs)

for d in devs {
    let rate: Float64 = prop(d, kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, 0)
    let buf: UInt32 = prop(d, kAudioDevicePropertyBufferFrameSize, kAudioObjectPropertyScopeGlobal, 0)
    let range: AudioValueRange = prop(d, kAudioDevicePropertyBufferFrameSizeRange, kAudioObjectPropertyScopeGlobal, AudioValueRange(mMinimum: 0, mMaximum: 0))
    let i = side(d, kAudioObjectPropertyScopeInput), o = side(d, kAudioObjectPropertyScopeOutput)
    print("\(name(d))  @ \(Int(rate)) Hz  buffer now \(buf), allowed \(Int(range.mMinimum))..\(Int(range.mMaximum))")
    if let i = i { print(String(format: "   in : device %4d + safety %4d + stream %4d frames = %5.2f ms (+ buffer)", i.lat, i.safe, i.stream, Double(i.lat + i.safe + i.stream) / rate * 1000)) }
    if let o = o { print(String(format: "   out: device %4d + safety %4d + stream %4d frames = %5.2f ms (+ buffer)", o.lat, o.safe, o.stream, Double(o.lat + o.safe + o.stream) / rate * 1000)) }
}
