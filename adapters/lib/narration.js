'use strict';
// Mid-turn narration meter (Claude Code only). Runs inside the PostToolUse
// adapter: measures narration accumulated so far in the current turn (every
// text block so far precedes a tool call, so all of it is narration) and
// returns a corrective line the moment the budget is crossed. If narration
// keeps growing after a correction, the meter re-arms: another quarter-budget
// of fresh narration since the last firing earns another correction — an
// ignored nudge repeats instead of going silent, but a single oversized block
// is corrected once.
//
// Deliberately does NOT run at Stop: attaching additionalContext at Stop
// forces another model turn with nothing to act on but the correction itself,
// which reliably degenerates into a stray acknowledgment worse than the
// violation. PostToolUse folds the correction into work already continuing.
// Costs zero tokens while the agent behaves. Ported from hush, MIT.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isRealUserPrompt } = require('./transcript');
const { safeWriteFileSync } = require('../../bin/lib/safe-write');

function budget() {
  const n = parseInt(process.env.TRIM_NARRATION_BUDGET || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 120;
}

function assistantTextBlocks(entry) {
  if (entry.type !== 'assistant' || entry.isSidechain) return [];
  const content = entry.message && entry.message.content;
  if (!Array.isArray(content)) return [];
  return content.filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text);
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

// All assistant text blocks since the last real user prompt, plus a stable
// key identifying that turn (for the state dedup).
function measureCurrentTurn(entries) {
  const texts = [];
  let turnKey = 'window-start';
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isRealUserPrompt(entries[i])) {
      turnKey = entries[i].uuid || entries[i].timestamp || 'unknown-turn';
      break;
    }
    texts.unshift(...assistantTextBlocks(entries[i]));
  }
  return {
    narration: texts.reduce((sum, t) => sum + wordCount(t), 0),
    blocks: texts.length,
    turnKey,
  };
}

// Pure firing decision. First correction of a turn fires when narration
// crosses the budget; after that, only fresh growth (a further quarter-budget
// since the last firing) re-arms it. A new turnKey starts over.
function stepMeter(prevState, turnKey, narration, budgetWords) {
  const sameTurn = !!(prevState && prevState.turnKey === turnKey);
  if (!sameTurn) {
    if (narration <= budgetWords) return { fire: false };
    return { fire: true, nextState: { turnKey, firedAt: narration } };
  }
  const firedAt = typeof prevState.firedAt === 'number' ? prevState.firedAt : narration;
  if (narration - firedAt < Math.ceil(budgetWords / 4)) return { fire: false };
  return { fire: true, nextState: { turnKey, firedAt: narration } };
}

function statePath(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9-]/g, '_');
  return path.join(os.tmpdir(), `trim-meter-${safe}.json`);
}

function readState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(statePath(sessionId), 'utf-8'));
  } catch {
    return {};
  }
}

function writeState(sessionId, state) {
  try {
    safeWriteFileSync(statePath(sessionId), JSON.stringify(state));
  } catch {
    /* best effort — losing state means one extra reminder, not breakage */
  }
}

// The correction line for this event, or undefined when the meter stays
// silent. Writes meter state only when it fires.
function narrationCorrection(evt, tailLines) {
  if (process.env.TRIM_NARRATION === 'off') return undefined;
  if (evt.hook_event_name !== 'PostToolUse') return undefined; // Stop is a deliberate no-op — see header
  if (!tailLines) return undefined;
  const entries = [];
  for (const line of tailLines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* skip malformed */
    }
  }
  const limit = budget();
  const { narration, blocks, turnKey } = measureCurrentTurn(entries);
  const { fire, nextState } = stepMeter(readState(evt.session_id), turnKey, narration, limit);
  if (!fire) return undefined;
  writeState(evt.session_id, nextState);
  return `trim: ${narration} words of narration across ${blocks} blocks so far this turn (budget ${limit}). Stop narrating — keep working silently and put everything in one final message.`;
}

module.exports = { narrationCorrection, measureCurrentTurn, wordCount, stepMeter, statePath, budget };
