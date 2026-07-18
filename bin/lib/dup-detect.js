'use strict';

const crypto = require('crypto');
const { readState, writeState } = require('./session-state');
const { stripAnsi } = require('../trim-core');

const KIND = 'trim-dup';
const LIMIT = 20;
function normalize(text) {
  return stripAnsi(text)
    .replace(/\b\d{4}-\d\d-\d\d[T ][0-9:.+-]+Z?\b/g, '<time>')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function hashText(text) {
  return crypto.createHash('sha256').update(normalize(text)).digest('hex');
}

function detectDuplicate(sessionId, text, now = Date.now()) {
  if (!sessionId || !text) return { duplicate: false, ageMs: null };
  const state = readState(KIND, sessionId);
  const ring = Array.isArray(state.ring) ? state.ring.filter((x) => x && typeof x.hash === 'string') : [];
  const hash = hashText(text);
  // Best-effort merge-on-write narrows the parallel-hook lost-update window
  // without introducing locking into this metrics-only ring.
  const latest = readState(KIND, sessionId);
  const merged = Array.isArray(latest.ring) ? latest.ring.filter((x) => x && typeof x.hash === 'string') : [];
  for (const entry of ring) {
    if (!merged.some((x) => x.hash === entry.hash && x.at === entry.at)) merged.push(entry);
  }
  const previous = merged.slice().reverse().find((x) => x.hash === hash);
  merged.push({ hash, at: now });
  merged.sort((a, b) => a.at - b.at);
  writeState(KIND, sessionId, { ring: merged.slice(-LIMIT) });
  return { duplicate: !!previous, ageMs: previous ? Math.max(0, now - previous.at) : null };
}

function clearDuplicates(sessionId) {
  return writeState(KIND, sessionId, { ring: [] });
}

module.exports = { LIMIT, normalize, hashText, detectDuplicate, clearDuplicates };
