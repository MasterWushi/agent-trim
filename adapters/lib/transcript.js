'use strict';

// Shared transcript-tail helpers (Claude Code only). The PostToolUse adapter
// needs the current turn's real human prompt for the enumeration carve-out
// and relevance preservation. The turn-boundary schema lives here so the
// origin.kind/isMeta rules cannot drift.
// Ported from hush (github.com/V-Songbird/hush), MIT.

const fs = require('fs');

// Fixed 1MB tail window: the hook runs on every tool call in long sessions, so
// never read the whole transcript. A single turn larger than the window
// undercounts — a documented ceiling.
const TAIL_BYTES = 1024 * 1024;

function readTailLines(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let lines = buf.toString('utf-8').split('\n');
    if (start > 0) lines = lines.slice(1); // drop the leading partial line
    return lines.filter((l) => l.trim());
  } finally {
    fs.closeSync(fd);
  }
}

function isRealUserPrompt(entry) {
  if (entry.type !== 'user' || entry.isSidechain) return false;
  // Harness-injected continuations look like fresh user turns but aren't:
  // task notifications carry origin.kind !== "human", scheduled wakeups carry
  // isMeta. Only a prompt a person typed is a turn boundary.
  if (entry.isMeta) return false;
  if (entry.origin && entry.origin.kind !== 'human') return false;
  const content = entry.message && entry.message.content;
  if (typeof content === 'string') return true;
  if (Array.isArray(content)) {
    // Tool results come back as type:"user" lines; a real prompt has text
    // items and no tool_result items.
    return content.some((c) => c.type === 'text') && !content.some((c) => c.type === 'tool_result');
  }
  return false;
}

function userPromptText(entry) {
  const content = entry.message && entry.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
  }
  return '';
}

// The most recent real human prompt in already-read tail lines — the one
// governing the current turn. '' when absent, so callers treat "unknown" as
// "no carve-out" and fail safe. Parses lazily from the end: a turn boundary is
// usually a few lines back even in a 1MB tail.
function lastUserPromptTextFromLines(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (isRealUserPrompt(entry)) return userPromptText(entry);
  }
  return '';
}

// One tail read per process. null when there is no readable transcript (bare
// harness).
function tailReader(transcriptPath) {
  let lines;
  let done = false;
  return () => {
    if (done) return lines;
    done = true;
    try {
      lines = transcriptPath && fs.existsSync(transcriptPath) ? readTailLines(transcriptPath) : null;
    } catch {
      lines = null;
    }
    return lines;
  };
}

module.exports = { readTailLines, isRealUserPrompt, userPromptText, lastUserPromptTextFromLines, tailReader, TAIL_BYTES };
