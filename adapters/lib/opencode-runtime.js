'use strict';
// opencode behaviour, as plain CommonJS required live from the repo root.
//
// Why this file exists: install.sh renders adapters/opencode-trim.ts into
// ~/.config/opencode/plugins/trim.ts, substituting the repo path. That copy is
// a SNAPSHOT — `git pull` cannot update it — so every line of logic living in
// the .ts wrapper goes stale until the installer is re-run. Keeping the wrapper
// thin and the logic here means a pull updates opencode too, because the
// wrapper requires this file by absolute path at runtime.
//
// This mirrors adapters/lib/pi-runtime.js, which is why pi-trim.ts survived the
// 0.4.0 release unchanged while opencode-trim.ts drifted.
const { compress, maybeLog, netWin, netWinTotals } = require('../../bin/trim-core.js');

// A throw from tool.execute.after is FAIL-CLOSED in opencode (the tool call
// itself errors), so the whole body stays inside try/catch.
async function afterToolExecute(input, output) {
  try {
    if (process.env.TRIM_OFF === '1') return;
    if (JSON.stringify((input && input.args) ?? '').includes('TRIM_OFF=1')) {
      maybeLog('opencode', null, null, { bypass: true });
      return;
    }
    const args = input && input.args;
    const command = args && typeof args.command === 'string' ? args.command : undefined;

    if (typeof output.output === 'string' && output.output) {
      const { out, stats, meta } = compress(output.output, { command, hostMayTruncate: true });
      const win = netWin(output.output, out, meta);
      maybeLog('opencode', win ? stats : { inBytes: meta.inputBytes, outBytes: meta.inputBytes }, meta, {
        command,
        applied: win ? undefined : false,
      });
      // rewrite only when it actually saves space, in bytes AND tokens
      if (win) output.output = out;
      return;
    }

    // MCP tool results arrive as a raw content array instead of a string
    // (mutate in place, same as output.output). Text items only; anything else
    // passes untouched. The net-win gate runs once over the whole array, so a
    // block that shrinks on its own can't drag the result past the gate.
    const content = output && output.content;
    if (Array.isArray(content)) {
      const pending = [];
      let bestMeta = null;
      let differs = false;
      let inBytes = 0;
      let outBytes = 0;
      let inLines = 0;
      let outLines = 0;
      let inTokEst = 0;
      let outTokEst = 0;
      for (const c of content) {
        if (!c || c.type !== 'text' || typeof c.text !== 'string' || !c.text) continue;
        const { out, meta } = compress(c.text, { command, hostMayTruncate: true });
        inBytes += meta.inputBytes;
        outBytes += meta.outputBytes;
        inLines += meta.inputLines;
        outLines += meta.outputLines;
        inTokEst += meta.inputTokenEstimate;
        outTokEst += meta.outputTokenEstimate;
        if (!bestMeta || meta.inputBytes > bestMeta.inputBytes) bestMeta = meta;
        if (out !== c.text) differs = true;
        pending.push({ c, out });
      }
      if (!pending.length) return;
      const win = differs && netWinTotals(inBytes, outBytes, inTokEst, outTokEst);
      maybeLog('opencode-mcp', win ? { inBytes, outBytes } : { inBytes, outBytes: inBytes }, bestMeta, {
        command,
        applied: win ? undefined : false,
        emitted: { inLines, outLines: win ? outLines : inLines, inTokEst, outTokEst: win ? outTokEst : inTokEst },
      });
      if (win) for (const p of pending) if (p.out !== p.c.text) p.c.text = p.out;
    }
  } catch {
    // never break the tool on adapter failure
  }
}

// The plugin object opencode expects. Exported as a factory so the wrapper can
// hand it straight back as its `Plugin`.
const Trim = async () => ({ 'tool.execute.after': afterToolExecute });

module.exports = { Trim, afterToolExecute };
