'use strict';

const {
  compress,
  maybeLog,
  extractExitCode,
  isFileDump,
  isLogPath,
  isGeneratedPath,
  isSidecarPath,
  isExactSidecarRange,
  pressureScale,
  cheapHash,
  netWinTotals,
  telemetryEnabled,
} = require('../../bin/trim-core');
const { detectDuplicate, clearDuplicates } = require('../../bin/lib/dup-detect');
const { readState: readGenericState, writeState: writeGenericState, statePath } = require('../../bin/lib/session-state');
const { PROFILES: PROFILE_CONFIG } = require('../../bin/profiles');
const { PRESERVATION_INSTRUCTIONS } = require('../claude-precompact');

const KIND = 'trim-pi';
const MAX_HANDLED = 200;
const PI_MAX_BYTES = 50 * 1024;
const PI_MAX_LINES = 2000;
const PROFILES = new Set(Object.keys(PROFILE_CONFIG));
const BLOCKER_RE = /\b(blocked|cannot proceed|need(?:s)? user|decision needed|fatal|error|failed|failure|final result)\b/i;

function emptyState(value) {
  const state = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    handled: state.handled && typeof state.handled === 'object' ? state.handled : {},
    pressureBand: typeof state.pressureBand === 'string' ? state.pressureBand : 'low',
    observedBytes: Number.isFinite(state.observedBytes) ? state.observedBytes : 0,
    compactionEpoch: Number.isInteger(state.compactionEpoch) ? state.compactionEpoch : 0,
    narration: state.narration && typeof state.narration === 'object' ? state.narration : {},
    profile: PROFILES.has(state.profile) ? state.profile : null,
    orderMarkers: Number.isInteger(state.orderMarkers) ? state.orderMarkers : 0,
    turnCounter: Number.isInteger(state.turnCounter) ? state.turnCounter : 0,
  };
}

function readState(sessionId) {
  return emptyState(readGenericState(KIND, sessionId));
}

function writeState(sessionId, state) {
  return writeGenericState(KIND, sessionId, emptyState(state));
}

function contentText(event) {
  if (!event || !Array.isArray(event.content)) return null;
  const parts = event.content.filter((part) => part && part.type === 'text' && typeof part.text === 'string');
  if (!parts.length) return null;
  return parts.map((part) => part.text).join('\n');
}

function hostComplete(event, text) {
  const details = event && event.details;
  if (details && typeof details === 'object') {
    if (details.truncated === true || details.fullOutputPath) return false;
    if (details.truncation && details.truncation.truncated === true) return false;
  }
  if (/\[(?:Truncated:|Full output saved to )/i.test(text)) return false;
  const lines = text ? text.split('\n').length : 0;
  return !(Buffer.byteLength(text || '') >= PI_MAX_BYTES || lines >= PI_MAX_LINES);
}

function boundedHandled(handled, id, hash) {
  const next = { ...handled };
  delete next[id];
  next[id] = hash;
  const keys = Object.keys(next);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_HANDLED))) delete next[key];
  return next;
}

function handleToolResult(event, priorState, env = {}) {
  const state = emptyState(priorState);
  const trimOff = Object.prototype.hasOwnProperty.call(env, 'TRIM_OFF') ? env.TRIM_OFF : process.env.TRIM_OFF;
  if (trimOff === '1') {
    return { patch: null, stateDelta: state, metrics: { bypass: true } };
  }
  if (!event || !['bash', 'read'].includes(event.toolName) || typeof event.toolCallId !== 'string') {
    return { patch: null, stateDelta: state, metrics: null };
  }
  const raw = contentText(event);
  if (raw === null) return { patch: null, stateDelta: state, metrics: null };
  if (JSON.stringify(event.input || '').includes('TRIM_OFF=1')) {
    return { patch: null, stateDelta: state, metrics: { bypass: true } };
  }
  const hash = cheapHash(raw);
  if (state.handled[event.toolCallId] === hash) return { patch: null, stateDelta: state, metrics: { repeated: true } };

  const command = event.toolName === 'bash' && event.input && typeof event.input.command === 'string' ? event.input.command : undefined;
  const filePath =
    event.toolName === 'read' && event.input
      ? event.input.path || event.input.file_path || event.input.filePath
      : undefined;
  if (event.toolName === 'read' && !isLogPath(filePath) && !isGeneratedPath(filePath) && !isSidecarPath(filePath)) {
    return { patch: null, stateDelta: { ...state, handled: boundedHandled(state.handled, event.toolCallId, hash) }, metrics: null };
  }

  const complete = hostComplete(event, raw);
  const observedBytes = state.observedBytes + Buffer.byteLength(raw);
  const pressure = pressureScale(Number.isFinite(env.contextBytes) ? env.contextBytes : observedBytes, state.pressureBand);
  const observed = telemetryEnabled();
  const duplicate = observed ? detectDuplicate(env.sessionId, raw) : { duplicate: false, ageMs: null };
  if (event.toolName === 'read' && isExactSidecarRange(filePath, event.input, raw)) {
    return {
      patch: null,
      stateDelta: {
        ...state,
        handled: boundedHandled(state.handled, event.toolCallId, hash),
        pressureBand: pressure.band,
        observedBytes,
        orderMarkers: state.orderMarkers + (raw.includes('[trim hook:') ? 1 : 0),
        turnCounter: state.turnCounter + 1,
      },
      metrics: {
        stats: null,
        meta: null,
        command: filePath,
        durMs: 0,
        dupExact: duplicate.duplicate,
        dupAgeMs: duplicate.ageMs,
        applied: false,
        verbatim: true,
      },
    };
  }
  const started = process.hrtime.bigint();
  const options = {
    command,
    exitCode: event.isError ? 1 : extractExitCode(event.details),
    isDump: event.toolName === 'read' || isFileDump(command),
    noSidecar: event.toolName === 'read' && isSidecarPath(filePath),
    hostMayTruncate: event.toolName === 'bash',
    hostComplete: complete,
    runtime: 'pi',
    sessionId: env.sessionId,
    profile: state.profile || env.TRIM_PROFILE,
    relevance: env.relevance,
    scale: pressure.scale,
  };
  const mapped = [];
  let changed = false;
  let bestMeta = null;
  let inBytes = 0;
  let outBytes = 0;
  let inLines = 0;
  let outLines = 0;
  let inTokEst = 0;
  let outTokEst = 0;
  for (const part of event.content) {
    if (!part || part.type !== 'text' || typeof part.text !== 'string') {
      mapped.push(part);
      continue;
    }
    const result = compress(part.text, options);
    inBytes += Buffer.byteLength(part.text);
    outBytes += Buffer.byteLength(result.out);
    if (result.meta) {
      inLines += result.meta.inputLines;
      outLines += result.meta.outputLines;
      inTokEst += result.meta.inputTokenEstimate;
      outTokEst += result.meta.outputTokenEstimate;
    }
    if (!bestMeta || (result.meta && result.meta.inputBytes > bestMeta.inputBytes)) bestMeta = result.meta;
    if (result.out !== part.text) changed = true;
    mapped.push({ ...part, text: result.out });
  }
  const win = changed && netWinTotals(inBytes, outBytes, inTokEst, outTokEst);
  const durMs = Number(process.hrtime.bigint() - started) / 1e6;
  const stateDelta = {
    ...state,
    handled: boundedHandled(state.handled, event.toolCallId, hash),
    pressureBand: pressure.band,
    observedBytes,
    orderMarkers: state.orderMarkers + (raw.includes('[trim hook:') ? 1 : 0),
    turnCounter: state.turnCounter + 1,
  };
  return {
    patch: win ? { content: mapped, details: event.details, isError: event.isError } : null,
    stateDelta,
    metrics: {
      stats: bestMeta ? { inBytes, outBytes: win ? outBytes : inBytes } : null,
      meta: bestMeta,
      command: command || filePath,
      durMs,
      hostTruncated: !complete,
      profile: options.profile || null,
      dupExact: duplicate.duplicate,
      dupAgeMs: duplicate.ageMs,
      applied: win ? undefined : false,
      emitted: {
        inLines,
        outLines: win ? outLines : inLines,
        inTokEst,
        outTokEst: win ? outTokEst : inTokEst,
      },
    },
  };
}

function resetForCompaction(state) {
  const current = emptyState(state);
  return { ...current, pressureBand: 'low', observedBytes: 0, narration: {}, compactionEpoch: current.compactionEpoch + 1 };
}

function resetVolatile(state, sessionId) {
  clearDuplicates(sessionId);
  return { ...emptyState(state), handled: {}, pressureBand: 'low', observedBytes: 0, narration: {}, orderMarkers: 0 };
}

function textFromMessage(message) {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return '';
  return message.content.filter((part) => part && part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
}

function stepNarration(state, text, profile, turnKey, budget = 70) {
  const current = emptyState(state);
  if (!['eval', 'autonomous-loop'].includes(profile) || !text || BLOCKER_RE.test(text)) return { state: current, exceeded: false };
  const words = text.split(/\s+/).filter(Boolean).length;
  const previous = current.narration.turnKey === turnKey ? current.narration : { turnKey, words: 0, firedAt: 0 };
  const total = previous.words + words;
  const threshold = previous.firedAt ? previous.firedAt + Math.ceil(budget / 4) : budget + 1;
  const exceeded = total >= threshold;
  return {
    state: { ...current, narration: { turnKey, words: total, firedAt: exceeded ? total : previous.firedAt } },
    exceeded,
    words: total,
  };
}

function logMetrics(metrics) {
  if (!metrics) return;
  if (metrics.repeated) return;
  if (metrics.bypass) return maybeLog('pi', null, null, { bypass: true });
  maybeLog('pi', metrics.stats, metrics.meta, metrics);
}

function logNarration(step, profile) {
  if (!step || !step.exceeded) return;
  maybeLog('pi-narration', null, null, { narrationWords: step.words, narrationExceeded: true, profile });
}

module.exports = {
  KIND,
  MAX_HANDLED,
  PI_MAX_BYTES,
  PI_MAX_LINES,
  PRESERVATION_INSTRUCTIONS,
  PROFILES,
  cheapHash,
  emptyState,
  readState,
  writeState,
  statePath: (sessionId) => statePath(KIND, sessionId),
  hostComplete,
  handleToolResult,
  resetForCompaction,
  resetVolatile,
  textFromMessage,
  stepNarration,
  logMetrics,
  logNarration,
};
