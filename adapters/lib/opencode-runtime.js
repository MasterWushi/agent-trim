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
const { compress, maybeLog, netWin } = require('../../bin/trim-core.js');

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
      maybeLog('opencode', stats, meta, { command });
      // rewrite only when it actually saves space, in bytes AND tokens
      if (netWin(output.output, out)) output.output = out;
      return;
    }

    // MCP tool results arrive as a raw content array instead of a string
    // (mutate in place, same as output.output). Text items only; anything else
    // passes untouched.
    const content = output && output.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (!c || c.type !== 'text' || typeof c.text !== 'string' || !c.text) continue;
        const { out, stats, meta } = compress(c.text, { command, hostMayTruncate: true });
        maybeLog('opencode-mcp', stats, meta, { command });
        if (netWin(c.text, out)) c.text = out;
      }
    }
  } catch {
    // never break the tool on adapter failure
  }
}

// The plugin object opencode expects. Exported as a factory so the wrapper can
// hand it straight back as its `Plugin`.
const Trim = async () => ({ 'tool.execute.after': afterToolExecute });

module.exports = { Trim, afterToolExecute };
