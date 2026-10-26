#!/bin/sh
# Build Amp.app and install it, so it opens like any other app: Spotlight
# (Cmd-Space, "Amp"), Launchpad, or the Dock.
#
#   tools/install-app.sh            build, install, open
#   tools/install-app.sh --no-open  build and install only
#
# Run it again after pulling changes. The first build fetches JUCE and takes
# a few minutes; after that it is seconds. To sign with your own identity, so
# macOS remembers the microphone permission across updates, set it once:
#
#   AMP_CODESIGN_IDENTITY=<hash from `security find-identity -v -p codesigning`> tools/install-app.sh
set -e
cd "$(dirname "$0")/../native/app"

# JUCE needs CMake 3.22 or newer; Homebrew's, if an older one is first on PATH.
CMAKE=cmake
for c in /opt/homebrew/bin/cmake /usr/local/bin/cmake cmake; do
  if command -v "$c" >/dev/null 2>&1; then
    v=$("$c" --version | head -1 | sed 's/[^0-9.]*//')
    major=${v%%.*}; rest=${v#*.}; minor=${rest%%.*}
    if [ "$major" -gt 3 ] || { [ "$major" -eq 3 ] && [ "$minor" -ge 22 ]; }; then CMAKE=$c; break; fi
  fi
done

if [ ! -f build/CMakeCache.txt ]; then
  gen=""
  command -v ninja >/dev/null 2>&1 && gen="-G Ninja"
  # shellcheck disable=SC2086
  "$CMAKE" -B build $gen ${AMP_CODESIGN_IDENTITY:+-DAMP_CODESIGN_IDENTITY=$AMP_CODESIGN_IDENTITY}
elif [ -n "$AMP_CODESIGN_IDENTITY" ]; then
  "$CMAKE" -B build -DAMP_CODESIGN_IDENTITY="$AMP_CODESIGN_IDENTITY" >/dev/null
fi
"$CMAKE" --build build

built=build/Amp_artefacts/Release/Standalone/Amp.app
dest=/Applications
[ -w "$dest" ] || { dest="$HOME/Applications"; mkdir -p "$dest"; }

# Quit a running copy first; it saves its settings on the way out.
if pgrep -x Amp >/dev/null; then
  osascript -e 'with timeout of 10 seconds' -e 'tell application "Amp" to quit' -e 'end timeout' >/dev/null 2>&1 || true
  i=0; while pgrep -x Amp >/dev/null && [ $i -lt 50 ]; do sleep 0.2; i=$((i + 1)); done
fi

rm -rf "$dest/Amp.app"
ditto "$built" "$dest/Amp.app"

# Tell macOS about the installed copy, and forget the one in the build
# folder, so Spotlight and the Dock find one Amp with its icon.
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$LSREGISTER" -u "$PWD/$built" >/dev/null 2>&1 || true
"$LSREGISTER" -f "$dest/Amp.app"

echo "Installed $dest/Amp.app — open it from Spotlight (Cmd-Space, \"Amp\") or Launchpad."
[ "$1" = "--no-open" ] || open "$dest/Amp.app"
