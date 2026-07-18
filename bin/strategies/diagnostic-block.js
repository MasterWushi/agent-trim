'use strict';

const START_RE = /^(.*?):(\d+)(?::\d+)?:\s*(?:(error|warning|note)(?:\[([^\]]+)\])?|(?:error|warning)\s+([A-Z]\d+))[:\s]/i;
const RUST_START_RE = /^(error|warning)(?:\[([^\]]+)\])?:\s+/i;

function normalized(block) {
  return block
    .replace(/^.*?:\d+(?::\d+)?:/m, '<location>:')
    .replace(/^\s*-->\s+.*?:\d+:\d+/gm, ' --> <location>')
    .replace(/^\s*\d+\s*\|/gm, '<line> |')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = {
  name: 'diagnostic-block',
  minBytes: 400,
  maxBytes: 2 * 1024 * 1024,
  apply(text, ctx) {
    const lines = text.split('\n');
    const blocks = [];
    let current = null;
    for (const line of lines) {
      const match = START_RE.exec(line);
      const rust = RUST_START_RE.exec(line);
      if (match || rust) {
        if (current) blocks.push(current);
        current = match
          ? { lines: [line], location: `${match[1]}:${match[2]}`, code: match[4] || match[5] || match[3] || 'diagnostic' }
          : { lines: [line], location: 'unknown', code: rust[2] || rust[1] };
      } else if (current && (line.trim() === '' || /^\s|^\s*[|^~]/.test(line))) {
        current.lines.push(line);
        const location = /^\s*-->\s+(.+?):(\d+)/.exec(line);
        if (location) current.location = `${location[1]}:${location[2]}`;
      }
      else if (current) {
        blocks.push(current);
        current = null;
      }
    }
    if (current) blocks.push(current);
    if (blocks.length < 3) return null;
    const covered = blocks.reduce((sum, block) => sum + block.lines.filter((line) => line.trim()).length, 0);
    const nonBlank = lines.filter((line) => line.trim()).length;
    if (covered < nonBlank * 0.5) return null;
    const groups = new Map();
    for (const block of blocks) {
      const body = block.lines.join('\n').trimEnd();
      const key = normalized(body);
      const group = groups.get(key) || { ...block, body, locations: [] };
      group.locations.push(block.location);
      groups.set(key, group);
    }
    const out = [];
    for (const group of groups.values()) {
      out.push(group.body);
      if (group.locations.length > 1) out.push(`${group.code} ×${group.locations.length} (${group.locations.slice(0, 3).join(', ')})`);
      out.push('');
    }
    const renderedBlocks = out.join('\n');
    if (ctx && typeof ctx.isSignal === 'function') {
      const extraSignals = lines.filter((line) => ctx.isSignal(line) && !renderedBlocks.includes(line));
      if (extraSignals.length) out.push('Other diagnostic signal:', ...extraSignals, '');
    }
    const rendered = out.join('\n').trimEnd();
    return rendered.length < text.length
      ? { out: rendered, lossy: groups.size < blocks.length, reason: 'diagnostic blocks preserved whole; normalized-identical blocks folded' }
      : null;
  },
};
