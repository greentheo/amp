#!/bin/sh
# Build the native lag probe once, optimised, then run it with whatever
# arguments were given. Optimised because it runs inside the CoreAudio IO
# callback at buffers as small as 16 frames; the interpreter would do, but
# there is no reason to measure latency with a handicapped build.
set -e
here=$(cd "$(dirname "$0")" && pwd)
bin="${TMPDIR:-/tmp}/amp-native-lag-probe"
src="$here/native-lag-probe.swift"
if [ ! -x "$bin" ] || [ "$src" -nt "$bin" ]; then
  echo "building the probe…" >&2
  swiftc -O "$src" -o "$bin" 2>&1 | grep -v warning >&2 || true
fi
exec "$bin" "$@"
