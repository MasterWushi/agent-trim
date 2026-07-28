'use strict';
// T7 — recovery detection (observe-only). Answers "does trimming cause extra
// work?" by flagging when a new tool result looks like a rerun/re-read of a
// recent one, and recording whether the PRECEDING result was trimmed. This
// module never touches model-visible output — it only writes to session
// state (a bounded ring buffer) and returns a `recovery` object for the
// caller to attach to a metrics record. No raw command text, file path, or
// output content is ever stored: only hashes/fingerprints.
const crypto = require('crypto');
const { readState, writeState } = require('./session-state');

const KIND = 'trim-recovery';
const MAX_ENTRIES = 32;
const WINDOW = 5; // "within the previous 1-5 results"

function hash(s) {
  return crypto.createHash('sha256').update(String(s == null ? '' : s)).digest('hex').slice(0, 16);
}

// entry (caller-supplied, per tool result):
//   commandFingerprint — { cmdWord, cmdHash } | null (see trim-core.js)
//   filePath           — raw path (hashed internally before storage)
//   range              — string identifying the read range, if applicable
//   contentHash        — sha256/any hash of the observed text
//   strategy, lossy, sidecar, markerKind, bypass, applied
//   isEditTool         — true when this tool call is an edit (breaks an
//                        "unchanged-validation" streak)
//   isSidecarRead      — true when this is a Read of a sidecar path
//   ts                 — ms timestamp (caller-supplied; Date.now() is
//                        unavailable in some callers, e.g. tests/workflows)
function buildStoredEntry(entry, seq) {
  return {
    seq,
    ts: entry.ts,
    commandFingerprint: entry.commandFingerprint || null,
    filePathHash: entry.filePath ? hash(entry.filePath) : null,
    range: entry.range || null,
    contentHash: entry.contentHash || null,
    strategy: entry.strategy || null,
    lossy: !!entry.lossy,
    sidecar: !!entry.sidecar,
    markerKind: entry.markerKind || null,
    bypass: !!entry.bypass,
    applied: entry.applied !== false,
    isEditTool: !!entry.isEditTool,
  };
}

function detectKind(stored, ring) {
  const window = ring.slice(-WINDOW);
  // trim-bypass-rerun: same fingerprint, this call has TRIM_OFF=1
  if (stored.bypass && stored.commandFingerprint) {
    for (let i = window.length - 1; i >= 0; i--) {
      const prev = window[i];
      if (prev.commandFingerprint && prev.commandFingerprint.cmdHash === stored.commandFingerprint.cmdHash) {
        return { kind: 'trim-bypass-rerun', prev };
      }
    }
  }
  // artifact-retrieval: a sidecar path is read shortly after a lossy digest
  if (stored.isSidecarRead) {
    for (let i = window.length - 1; i >= 0; i--) {
      const prev = window[i];
      if (prev.lossy && prev.sidecar) return { kind: 'artifact-retrieval', prev };
    }
  }
  // same-read: identical file path + range, unchanged content hash
  if (stored.filePathHash && stored.contentHash) {
    for (let i = window.length - 1; i >= 0; i--) {
      const prev = window[i];
      if (
        prev.filePathHash === stored.filePathHash &&
        prev.range === stored.range &&
        prev.contentHash === stored.contentHash
      ) {
        return { kind: 'same-read', prev };
      }
    }
  }
  // same-command / unchanged-validation: identical command fingerprint
  if (stored.commandFingerprint) {
    let editSeen = false;
    for (let i = window.length - 1; i >= 0; i--) {
      const prev = window[i];
      if (prev.isEditTool) editSeen = true;
      if (prev.commandFingerprint && prev.commandFingerprint.cmdHash === stored.commandFingerprint.cmdHash) {
        return { kind: editSeen ? 'same-command' : 'unchanged-validation', prev };
      }
    }
  }
  return null;
}

// Reset all state on: compaction (epoch increment), session end, fork,
// branch switch — callers pass the current epoch; a change from the stored
// epoch clears the ring. Never shared across sessions (keyed by sessionId).
function observe(sessionId, epoch, entry) {
  const state = readState(KIND, sessionId);
  const ring = state.epoch === epoch && Array.isArray(state.ring) ? state.ring : [];
  const seq = state.epoch === epoch && Number.isInteger(state.seq) ? state.seq : 0;

  const stored = buildStoredEntry(entry, seq);
  stored.isSidecarRead = !!entry.isSidecarRead;

  const match = detectKind(stored, ring);
  const result = match
    ? {
        candidate: true,
        kind: match.kind,
        precedingMarkerKind: match.prev.markerKind,
        precedingLossy: match.prev.lossy,
        precedingApplied: match.prev.applied,
        ageMs: typeof entry.ts === 'number' && typeof match.prev.ts === 'number' ? entry.ts - match.prev.ts : null,
        seqGap: seq - match.prev.seq,
      }
    : { candidate: false, kind: null, precedingMarkerKind: null, precedingLossy: false, precedingApplied: false, ageMs: null, seqGap: null };

  const nextRing = ring.concat([stored]).slice(-MAX_ENTRIES);
  writeState(KIND, sessionId, { epoch, ring: nextRing, seq: seq + 1 });

  return result;
}

module.exports = { observe, MAX_ENTRIES, WINDOW };
