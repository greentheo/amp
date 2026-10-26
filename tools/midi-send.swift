// A virtual MIDI controller, for testing the app's MIDI without hardware.
//
//   swift tools/midi-send.swift [script.json]
//
// Creates a CoreMIDI source called "Amp Test", waits for listeners to see
// it, then plays a script: a JSON array of [seconds, status, data1, data2],
// each sent that many seconds after the previous one. Without a script it
// sends one CC 21 sweep. Any app listening — Amp.app, a DAW, MIDI Monitor —
// sees an ordinary controller.

import CoreMIDI
import Foundation

var client = MIDIClientRef()
MIDIClientCreate("amp-midi-send" as CFString, nil, nil, &client)
var source = MIDIEndpointRef()
guard MIDISourceCreate(client, "Amp Test" as CFString, &source) == noErr else {
    FileHandle.standardError.write("could not create the virtual source\n".data(using: .utf8)!)
    exit(1)
}

var steps: [[Double]] = (0...8).map { [0.05, 0xB0, 21, Double($0 * 16 > 127 ? 127 : $0 * 16)] }
if CommandLine.arguments.count > 1,
   let data = FileManager.default.contents(atPath: CommandLine.arguments[1]),
   let parsed = try? JSONSerialization.jsonObject(with: data) as? [[Double]] {
    steps = parsed
}

// Give listeners time to notice the new device and open it.
Thread.sleep(forTimeInterval: 2.5)

for step in steps {
    Thread.sleep(forTimeInterval: step[0])
    var bytes = step.dropFirst().map { UInt8($0) }
    var list = MIDIPacketList()
    let packet = MIDIPacketListInit(&list)
    MIDIPacketListAdd(&list, MemoryLayout<MIDIPacketList>.size, packet, 0, bytes.count, &bytes)
    MIDIReceived(source, &list)
    print(String(format: "sent %02X %d %d", Int(step[1]), Int(step[2]), step.count > 3 ? Int(step[3]) : 0))
}

Thread.sleep(forTimeInterval: 0.5)
MIDIEndpointDispose(source)
