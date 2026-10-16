#!/bin/sh
# Run bias-render.py under Rosetta, in the x86_64 venv.
#
# BIAS AMP 2 is an x86_64-only plugin. An arm64 Python cannot load it, and the
# failure is an unhelpful "unsupported plugin format or scan failure" rather
# than anything about architecture — so this wrapper exists to make the right
# thing the easy thing.
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
venv="$here/.venv-x86"
if [ ! -x "$venv/bin/python" ]; then
  echo "Setting up the x86_64 environment (once)..." >&2
  arch -x86_64 /usr/bin/python3 -m venv "$venv"
  arch -x86_64 "$venv/bin/python" -m pip install -q --upgrade pip
  arch -x86_64 "$venv/bin/python" -m pip install -q pedalboard numpy
fi
exec arch -x86_64 "$venv/bin/python" "$here/tools/bias-render.py" "$@"
