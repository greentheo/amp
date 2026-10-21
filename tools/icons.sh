#!/bin/sh
# Render Amp's icons from icons/amp.svg, the one drawing they all come from.
#
#   tools/icons.sh
#
# amp.svg is drawn on Apple's macOS grid: a rounded square inset in a 1024
# canvas, with its shadow baked in, because macOS draws neither. iOS and the
# web's home-screen icons want the opposite — the art full-bleed to a plain
# square, which the system rounds itself — so that variant is cut from the
# same drawing here rather than kept as a second one that drifts.
#
# Needs Google Chrome (headless, for an exact render of the filters) and
# ImageMagick; zopflipng shrinks the results if it is installed.
set -e
cd "$(dirname "$0")/.."
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

render() {  # svg-file out-png
  case "$1" in /*) src="$1" ;; *) src="$PWD/$1" ;; esac
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 \
    --window-size=1024,1024 --screenshot="$2" "file://$src" 2>/dev/null
  [ -s "$2" ] || { echo "render failed: $1" >&2; exit 1; }
}

# The macOS icon, and the small sizes the page uses.
render icons/amp.svg "$tmp/mac.png"
cp "$tmp/mac.png" icons/amp-1024.png
magick "$tmp/mac.png" -resize 64x64 icons/amp-64.png
magick "$tmp/mac.png" -resize 32x32 icons/amp-32.png

# Full-bleed: no shadow, square corners, the rounded square's 824 scaled up
# to fill the canvas.
sed -e 's/ filter="url(#shadow)"//' -e 's/rx="186"/rx="0"/g' \
    -e 's/viewBox="0 0 1024 1024"/viewBox="100 100 824 824"/' icons/amp.svg > "$tmp/square.svg"
render "$tmp/square.svg" "$tmp/square.png"
# Only the home-screen size is kept for now; the iOS app will want the
# 1024 master, which this line makes on the way.
magick "$tmp/square.png" -background "#0f0b09" -alpha remove -alpha off "$tmp/square-1024.png"
magick "$tmp/square-1024.png" -resize 180x180 icons/apple-touch-icon.png

if command -v zopflipng >/dev/null; then
  for f in icons/*.png; do zopflipng -y -m "$f" "$f" >/dev/null; done
fi
ls -l icons/*.png | awk '{ printf "  %-28s %7d bytes\n", $9, $5 }'
