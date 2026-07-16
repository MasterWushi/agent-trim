'use strict';
// eslint --format json: one JSON array of { filePath, messages: [...] }.
// The JSON wrapper (plus `source`/`output` excerpts eslint embeds) is nearly
// all overhead; the compact rendering keeps EVERY message with its file,
// line:col, severity, rule id, and text. Clean files collapse to a count.
// Detection is a full parse + shape check — no format is more certain.

const SEV = { 1: 'warning', 2: 'error' };
const MAX_MESSAGES = 1000; // pathological runs: let sidecar/generic handle

module.exports = {
  name: 'eslint-json',
  minBytes: 2000,
  apply(text) {
    const t = text.trim();
    if (!t.startsWith('[') || !t.endsWith(']')) return null;
    let data;
    try {
      data = JSON.parse(t);
    } catch {
      return null;
    }
    if (!Array.isArray(data) || !data.length) return null;
    if (!data.every((f) => f && typeof f === 'object' && typeof f.filePath === 'string' && Array.isArray(f.messages)))
      return null;

    const body = [];
    let errors = 0;
    let warnings = 0;
    let dirtyFiles = 0;
    let cleanFiles = 0;
    let total = 0;
    let dupes = 0;
    const seen = new Set();
    for (const f of data) {
      if (!f.messages.length) {
        cleanFiles++;
        continue;
      }
      dirtyFiles++;
      body.push(f.filePath);
      for (const m of f.messages) {
        if (++total > MAX_MESSAGES) return null;
        const sev = m.fatal ? 'fatal' : SEV[m.severity] || 'unknown';
        if (sev === 'error' || sev === 'fatal') errors++;
        else if (sev === 'warning') warnings++;
        const key = `${f.filePath}:${m.line}:${m.column}:${m.ruleId}:${m.message}`;
        if (seen.has(key)) {
          dupes++;
          continue;
        }
        seen.add(key);
        body.push(`  ${m.line || 0}:${m.column || 0}  ${sev}  ${m.message}${m.ruleId ? `  (${m.ruleId})` : ''}`);
      }
    }
    const head =
      `[trim hook: eslint JSON rendered compactly — ${errors} error${errors === 1 ? '' : 's'}, ` +
      `${warnings} warning${warnings === 1 ? '' : 's'} in ${dirtyFiles} file${dirtyFiles === 1 ? '' : 's'}` +
      (cleanFiles ? `; ${cleanFiles} clean file${cleanFiles === 1 ? '' : 's'} omitted` : '') +
      (dupes ? `; ${dupes} exact duplicate${dupes === 1 ? '' : 's'} deduped` : '') +
      `. Every message kept with file, line:col, and rule.]`;
    return {
      out: [head, ...body].join('\n'),
      // Clean-file names and eslint's embedded source excerpts are dropped;
      // every diagnostic survives.
      lossy: cleanFiles > 0,
      reason: 'eslint JSON reformatted; all diagnostics kept',
    };
  },
};
