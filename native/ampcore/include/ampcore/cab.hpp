// The speaker cabinet's impulse response, ported from js/audio/cab.js.
//
// A click, a few panel bounces and a little seeded cone noise, pushed through
// six filters, normalised by energy and faded. The tables are the fitted ones
// the browser ships (see cab.js for what fitted means here — the names are
// each filter's job, not a datasheet).

#pragma once
#include <map>
#include <string>
#include <vector>

namespace ampcore {

/**
 * A cab as the browser's renderCab() receives it: a speaker id plus numeric
 * options — axis, distance, and any speaker-table or shape value to
 * override. Only keys actually present take part in the noise seed, exactly
 * as in the JS, so the same options give the same speaker in both builds.
 */
struct CabOpts {
    std::string speaker = "v30";
    std::map<std::string, double> num = {{"axis", 0.6}, {"distance", 0.25}};
};

/** The rendered IR, mono, `round(rate * 0.09)` samples long. */
std::vector<float> renderCab(double rate, const CabOpts& opts);

}  // namespace ampcore
