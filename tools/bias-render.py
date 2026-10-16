#!/usr/bin/env python3
"""Render the calibration stimulus through the BIAS AMP 2 plugin, headless.

    tools/bias.sh --list
    tools/bias.sh --out calibration/bias-default.wav
    tools/bias.sh --set gain=0.7 --set bass=0.5 --out calibration/bias-hot.wav
    tools/bias.sh --sweep gain=0.2,0.5,0.8 --out-dir calibration

Always launch it through `tools/bias.sh`, which puts it under Rosetta. BIAS
AMP 2 ships x86_64 only, so an arm64 Python cannot load it at all — the error
you get is an unhelpful "unsupported plugin format or scan failure".

TWO THINGS THAT WILL SILENTLY RUIN A CAPTURE
--------------------------------------------

1. Block size. BIAS smooths its parameters once per processing block, so the
   smoothing time constant scales with the block. At pedalboard's default
   8192 samples a steady tone ramps up over 44 dB across the first minute and
   has not finished. At 128 it settles inside half a second. Measured:

       buffer   RMS @0.5s   @2s     @5s     @9s     spread
          64     -11.50   -11.36  -11.36  -11.36    0.15 dB
         128     -11.59   -11.35  -11.36  -11.36    0.23 dB
        1024     -22.22   -12.36  -11.42  -11.37   10.85 dB
        8192     -59.44   -32.65  -20.43  -14.73   44.71 dB

   Nothing about the output looks broken at 8192. It is just wrong, slowly.

2. Pre-roll. Even at 128 the first fraction of a second is settling, and the
   stimulus puts its alignment marker at 1.0 s. A pre-roll is processed and
   thrown away so the captured file starts from a settled plugin.
"""

import argparse
import itertools
import json
import os
import plistlib
import sys

AU = '/Library/Audio/Plug-Ins/Components/BIAS AMP 2.component'
PRESETS = os.path.expanduser('~/Documents/PositiveGrid/BIAS_Amp2/GlobalPresets')
BLOCK = 128
PREROLL_SEC = 1.0


def find_amps(root=PRESETS):
    """Every factory amp, as {name: (category, directory)}.

    The presets are plain JSON on disk — meta.json names them, data.json
    holds the signal path, template.json the panel artwork.
    """
    out = {}
    if not os.path.isdir(root):
        return out
    for cat in sorted(os.listdir(root)):
        cdir = os.path.join(root, cat)
        if not os.path.isdir(cdir):
            continue
        for uid in sorted(os.listdir(cdir)):
            meta = os.path.join(cdir, uid, 'meta.json')
            if not os.path.exists(meta):
                continue
            try:
                with open(meta) as f:
                    m = json.load(f)
            except Exception:
                continue
            out[m.get('displayName', uid)] = (cat, os.path.join(cdir, uid))
    return out


def read_state(plug):
    """The plugin's state as (plist, parsed JSON, trailing bytes).

    BIAS keeps its whole state as JSON inside the plist's jucePluginState,
    with a single null terminator after it. That is the lucky break that
    makes amp models scriptable at all: the six exposed parameters are only
    the knobs, and the amp *model* lives in here.
    """
    pl = plistlib.loads(bytes(plug.raw_state))
    blob = bytes(pl['jucePluginState'])
    js = blob.split(b'\x00')[0]
    return pl, json.loads(js.decode('utf-8')), blob[len(js):]


def load_amp(plug, directory):
    """Swap the amp model, keeping everything else about the state."""
    with open(os.path.join(directory, 'data.json')) as f:
        data = json.load(f)
    with open(os.path.join(directory, 'template.json')) as f:
        template = json.load(f)
    with open(os.path.join(directory, 'meta.json')) as f:
        meta = json.load(f)

    pl, st, tail = read_state(plug)
    st['project']['amp2']['sigPath'] = data['sigPath']
    st['project']['ampName'] = meta['displayName']
    st['project']['panel'] = template
    st['browsePath'] = {'items': [{'ampId': meta['id'], 'name': 'root', 'type': 'FACTORY'}]}
    pl['jucePluginState'] = json.dumps(st).encode() + tail
    plug.raw_state = plistlib.dumps(pl, fmt=plistlib.FMT_BINARY)
    return meta['displayName']


def current_amp(plug):
    try:
        return read_state(plug)[1]['project']['ampName']
    except Exception:
        return '(unknown)'


def load(path):
    import pedalboard
    if not os.path.exists(path):
        sys.exit(f'plugin not found: {path}\n'
                 'Install the BIAS AMP 2 AU, or pass --plugin.')
    try:
        return pedalboard.load_plugin(path)
    except Exception as e:
        sys.exit(f'could not load {path}: {e}\n'
                 'If this says "unsupported plugin format", the plugin is x86_64 '
                 'and this Python is not — run it through tools/bias.sh.')


def render(plug, x, rate, params, preroll=PREROLL_SEC):
    """Render `x` with `params` applied, discarding a settling pre-roll."""
    import numpy as np
    for k, v in params.items():
        setattr(plug, k, float(v))
    n = int(preroll * rate)
    if n:
        # Pre-roll on a copy of the opening, so the plugin settles on material
        # of roughly the right level rather than on silence.
        head = x[:, :n] if x.shape[1] >= n else x
        padded = np.concatenate([head, x], axis=1)
        y = plug(padded, rate, reset=True, buffer_size=BLOCK)
        return y[:, head.shape[1]:]
    return plug(x, rate, reset=True, buffer_size=BLOCK)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--plugin', default=AU)
    ap.add_argument('--stimulus', default='calibration/stimulus.wav')
    ap.add_argument('--out')
    ap.add_argument('--out-dir', default='calibration')
    ap.add_argument('--list', action='store_true', help='print parameters and exit')
    ap.add_argument('--list-amps', action='store_true', help='print the factory amp models and exit')
    ap.add_argument('--amp', help='factory amp model to load, by display name')
    ap.add_argument('--set', action='append', default=[], metavar='NAME=VALUE')
    ap.add_argument('--sweep', action='append', default=[], metavar='NAME=V1,V2,...',
                    help='render one file per combination')
    ap.add_argument('--preroll', type=float, default=PREROLL_SEC)
    ap.add_argument('--save-state', metavar='FILE',
                    help="write the plugin's raw state, so a model picked in the GUI can be reused")
    ap.add_argument('--load-state', metavar='FILE')
    args = ap.parse_args()

    if args.list_amps:
        amps = find_amps()
        if not amps:
            sys.exit(f'no presets under {PRESETS}')
        cat = None
        for name, (c, _) in sorted(amps.items(), key=lambda kv: (kv[1][0], kv[0])):
            if c != cat:
                cat = c
                print(f'\n{cat}')
            print(f'   {name}')
        print(f'\n{len(amps)} amps. Use --amp "<name>".')
        return

    plug = load(args.plugin)

    if args.amp:
        amps = find_amps()
        if args.amp not in amps:
            near = [n for n in amps if args.amp.lower() in n.lower()]
            sys.exit(f'no amp called {args.amp!r}.' +
                     (f' Did you mean: {", ".join(near)}?' if near else
                      ' Run --list-amps to see them.'))
        print(f'amp: {load_amp(plug, amps[args.amp][1])}')

    if args.load_state:
        with open(args.load_state, 'rb') as f:
            plug.raw_state = f.read()
        print(f'state restored from {args.load_state}')

    if args.list:
        print(f'{plug.name} — {plug.manufacturer_name} {plug.version}')
        print(f'  amp model: {current_amp(plug)}')
        for k in plug.parameters:
            print(f'  {k:12s} = {getattr(plug, k):.4f}')
        if args.save_state:
            with open(args.save_state, 'wb') as f:
                f.write(bytes(plug.raw_state))
            print(f'state written to {args.save_state}')
        return

    fixed = {}
    for s in args.set:
        k, _, v = s.partition('=')
        if k not in plug.parameters:
            sys.exit(f'no such parameter: {k}\nhave: {", ".join(plug.parameters)}')
        fixed[k] = float(v)

    axes = []
    for s in args.sweep:
        k, _, v = s.partition('=')
        if k not in plug.parameters:
            sys.exit(f'no such parameter: {k}\nhave: {", ".join(plug.parameters)}')
        axes.append((k, [float(x) for x in v.split(',')]))

    from pedalboard.io import AudioFile
    with AudioFile(args.stimulus) as f:
        rate = f.samplerate
        x = f.read(f.frames)
    print(f'{args.stimulus}: {x.shape[1] / rate:.1f} s @ {rate / 1000:g} kHz, '
          f'block {BLOCK}, pre-roll {args.preroll:g} s')

    combos = [dict(zip([a[0] for a in axes], vals))
              for vals in itertools.product(*[a[1] for a in axes])] if axes else [{}]

    for combo in combos:
        params = {**fixed, **combo}
        if args.out and len(combos) == 1:
            out = args.out
        else:
            tag = '-'.join(f'{k}{v:g}'.replace('.', '') for k, v in sorted(params.items())) or 'default'
            amp = (args.amp or current_amp(plug)).replace(' ', '').replace("'", '')
            out = os.path.join(args.out_dir, f'bias-{amp}-{tag}.wav')
        y = render(plug, x, rate, params, args.preroll)
        os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
        with AudioFile(out, 'w', rate, y.shape[0], bit_depth=24) as f:
            f.write(y)
        desc = ', '.join(f'{k}={v:g}' for k, v in sorted(params.items())) or 'plugin defaults'
        print(f'  {out}   {desc}')


if __name__ == '__main__':
    main()
