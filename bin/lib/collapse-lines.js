'use strict';
// Drop every line `isNoise` accepts and put one marker where the first one
// was. Lines are tested in order, so a stateful predicate works. Returns
// { out, removed }, or null when fewer than `min` lines would go.
function collapseLines(text, isNoise, min, marker) {
  const out = [];
  let removed = 0;
  let markerAt = -1;
  for (const line of text.split('\n')) {
    if (isNoise(line)) {
      if (markerAt === -1) {
        markerAt = out.length;
        out.push(''); // placeholder for the marker
      }
      removed++;
      continue;
    }
    out.push(line);
  }
  if (removed < min) return null;
  out[markerAt] = marker(removed);
  return { out: out.join('\n'), removed };
}

module.exports = { collapseLines };
