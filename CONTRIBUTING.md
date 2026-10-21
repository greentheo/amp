# Contributing to Amp

## Licence of contributions

Amp is AGPLv3-or-later with an additional permission for app stores
([APP-STORE-EXCEPTION.md](APP-STORE-EXCEPTION.md)), so that the same code
can ship on GitHub, as a signed Mac download, and through Apple's stores.

By contributing, you agree that your contribution is licensed on those same
terms — the AGPLv3 or any later version, together with that additional
permission — and that you have the right to license it that way. Inbound
equals outbound: nothing is asked of you that the project does not also
give.

Sign off each commit to say so, with `git commit -s`. The sign-off is the
[Developer Certificate of Origin](https://developercertificate.org/): a
statement that you wrote the change or otherwise have the right to submit it
under these terms.

## Changing the sound

The browser build and the native build (`native/ampcore`) are the same amp
twice, and they are held to sounding identical: not close, identical to
within float rounding. A change to the DSP in one goes into the other in the
same pull request, and the null test has to pass:

```
(cd native/ampcore && mkdir -p build && cd build && cmake .. && cmake --build .)
node tools/native-null.mjs chain
```

Render the references first, in the page, with
`await amp.renderChain('chain-<name>')`. The README's section on the native
build explains the rules that keep the two builds bit-for-bit close: float32
rounding where the JavaScript rounds, no fast-math, no fused multiply-add.
