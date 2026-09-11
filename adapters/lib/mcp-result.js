'use strict';
// T8 — MCP coverage, observe mode only. The `^(Bash|Read)$` PostToolUse
// matcher default is untouched (see docs/improvement-plan-audit.md §3.3):
// an MCP result may already be a curated/condensed digest a generic cap
// would corrupt, so this module never blindly rewrites. It:
//   - deep-copies the result; transforms only exactly-recognized text blocks
//   - preserves images/audio/blobs/resource links/embedded resources,
//     annotations, _meta, structuredContent, isError, and unknown fields
//   - preserves block order, never flattens mixed content into one string
//   - never turns a structured error into successful text
//   - passes the WHOLE result through unchanged if any shape is ambiguous
const { compress, alreadyCondensed, netWinTotals } = require('../../bin/trim-core.js');

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// A block this module is willing to touch: exactly `{ type: 'text', text: string, ...rest }`.
// Anything else (image, audio, resource, resource_link, unknown future type,
// or a text-shaped block with extra ambiguity) passes through untouched.
function isRecognizedTextBlock(block) {
  return isPlainObject(block) && block.type === 'text' && typeof block.text === 'string';
}

function deepCopy(v) {
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return null;
  }
}

// Decide, per block, whether a transform is even eligible (before running
// compress()): deny outright on alreadyCondensed() text or a denylisted tool.
function blockEligible(text, opts) {
  if (alreadyCondensed(text)) return false;
  if (opts.denyRe && opts.denyRe.test(opts.toolName || '')) return false;
  return true;
}

// mode: 'off' | 'observe' | 'on'
// allowRe: RegExp | undefined — required for 'on' to actually apply; with no
//          allowlist, 'on' behaves exactly like 'observe' (never applies).
// denyRe: RegExp | undefined
// Returns { out, applied, observed, totals, meta } — `out` is the (possibly
// deep-copied, possibly transformed) result; in 'observe' mode `out` is always
// deep-equal to the original result. `totals` aggregates every eligible text
// block, so the caller can apply the same final net-win gate and record the
// bytes actually returned.
function processMcpResult(result, { toolName, mode, allowRe, denyRe, compressOpts } = {}) {
  try {
    if (mode === 'off') return { out: result, applied: false, observed: [], totals: null, meta: null };
    if (!isPlainObject(result) || !Array.isArray(result.content)) {
      // Not the shape we understand — pass the whole result through.
      return { out: result, applied: false, observed: [], totals: null, meta: null };
    }

    const canApply = mode === 'on' && allowRe instanceof RegExp && allowRe.test(toolName || '');
    const copy = deepCopy(result);
    if (!copy) return { out: result, applied: false, observed: [], totals: null, meta: null };
    const observed = [];
    const candidates = [];
    let bestMeta = null;
    let inBytes = 0;
    let outBytes = 0;
    let inLines = 0;
    let outLines = 0;
    let inTokEst = 0;
    let outTokEst = 0;

    for (let i = 0; i < copy.content.length; i++) {
      const block = copy.content[i];
      if (!isRecognizedTextBlock(block) || !block.text) continue; // preserve non-text / ambiguous / empty blocks exactly
      if (!blockEligible(block.text, { toolName, denyRe })) continue;

      const { out, meta } = compress(block.text, compressOpts || {});
      inBytes += meta.inputBytes;
      inLines += meta.inputLines;
      inTokEst += meta.inputTokenEstimate;
      if (!bestMeta || meta.inputBytes > bestMeta.inputBytes) bestMeta = meta;
      if (out === block.text) {
        outBytes += meta.inputBytes;
        outLines += meta.inputLines;
        outTokEst += meta.inputTokenEstimate;
        continue;
      }
      outBytes += meta.outputBytes;
      outLines += meta.outputLines;
      outTokEst += meta.outputTokenEstimate;
      observed.push({ index: i, inBytes: meta.inputBytes, outBytes: meta.outputBytes, strategy: meta.strategy, lossy: meta.lossy });
      candidates.push({ index: i, block, out });
    }

    const totals = { inBytes, outBytes, inLines, outLines, inTokEst, outTokEst };
    let applied = false;
    if (canApply && candidates.length && netWinTotals(inBytes, outBytes, inTokEst, outTokEst)) {
      for (const c of candidates) copy.content[c.index] = { ...c.block, text: c.out };
      applied = true;
    }

    return { out: applied ? copy : result, applied, observed, totals, meta: bestMeta };
  } catch {
    // Any ambiguity/failure: passthrough, unchanged, nothing recorded.
    return { out: result, applied: false, observed: [], totals: null, meta: null };
  }
}

module.exports = { processMcpResult, isRecognizedTextBlock, isPlainObject };
