'use strict';
// JSON Lines logs (bunyan/pino/winston/structured app logs). Compact JSON is
// one whitespace token per line, so the generic template collapser can never
// fold it — this is the format where a dedicated strategy earns its keep.
// Every warn/error/fatal record is kept verbatim; info/debug/trace records
// collapse to a per-level census. First and last records are kept for
// temporal context.

const LEVEL_KEYS = ['level', 'severity', 'lvl', 'loglevel', 'log.level'];
// String levels that must be kept. Numeric levels: >= 40 covers bunyan/pino
// warn(40)+ and python logging ERROR(40)+; python WARNING(30) collides with
// pino info(30) — kept out, the string form is what python emits anyway.
const KEEP_LEVEL = /^(err(or)?|fatal|crit(ical)?|warn(ing)?|alert|emerg(ency)?)$/i;
const MIN_RECORDS = 20;
const MAX_KEPT = 300; // mostly-errors log: generic/sidecar handles it better

function levelOf(obj) {
  for (const k of LEVEL_KEYS) {
    if (obj[k] !== undefined) return obj[k];
  }
  return undefined;
}

function isKeepLevel(v) {
  if (typeof v === 'number') return v >= 40;
  if (typeof v === 'string') return KEEP_LEVEL.test(v.trim());
  return false;
}

module.exports = {
  name: 'jsonl-log',
  minBytes: 2000,
  apply(text) {
    const lines = text.split('\n');
    const nonEmpty = [];
    for (let i = 0; i < lines.length; i++) if (lines[i].trim()) nonEmpty.push(i);
    if (nonEmpty.length < MIN_RECORDS) return null;
    // cheap prefilter before parsing everything
    for (const i of nonEmpty.slice(0, 5)) {
      if (!lines[i].trimStart().startsWith('{')) return null;
    }

    let parsed = 0;
    let withLevel = 0;
    const keep = new Set();
    const levelCounts = new Map();
    for (const i of nonEmpty) {
      let obj;
      try {
        obj = JSON.parse(lines[i]);
      } catch {
        keep.add(i); // an unparseable line inside a JSONL stream is unusual — keep it
        continue;
      }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null; // not a JSONL log
      parsed++;
      const lvl = levelOf(obj);
      if (lvl === undefined) {
        keep.add(i); // no level — can't judge, keep
        continue;
      }
      withLevel++;
      if (isKeepLevel(lvl)) {
        keep.add(i);
      } else {
        const name = String(lvl);
        levelCounts.set(name, (levelCounts.get(name) || 0) + 1);
      }
    }
    // Confidence gates: nearly everything parsed, and levels are the norm.
    if (parsed < nonEmpty.length * 0.9) return null;
    if (withLevel < parsed * 0.9) return null;
    if (keep.size > MAX_KEPT) return null;

    // temporal context: first and last record always shown
    keep.add(nonEmpty[0]);
    keep.add(nonEmpty[nonEmpty.length - 1]);

    const collapsed = [...levelCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([lvl, n]) => `${n} ${lvl}`)
      .join(', ');
    const dropped = parsed + (nonEmpty.length - parsed) - keep.size;
    if (dropped < MIN_RECORDS) return null; // not enough to be worth a marker

    const keptSorted = [...keep].sort((a, b) => a - b);
    const out = [
      `[trim hook: JSONL log — ${dropped} routine records collapsed (${collapsed}); ` +
        `every warn/error/fatal record plus the first and last record kept verbatim below]`,
    ];
    let last = -1;
    for (const i of keptSorted) {
      if (last !== -1 && i - last > 1) out.push(`[trim hook: ${i - last - 1} routine records omitted here]`);
      out.push(lines[i]);
      last = i;
    }
    return {
      out: out.join('\n'),
      lossy: true,
      omittedLines: dropped,
      reason: 'JSONL log collapsed by level; all warn/error records kept',
    };
  },
};
