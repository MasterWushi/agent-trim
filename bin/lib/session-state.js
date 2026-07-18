'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { safeWriteFileSync } = require('./safe-write');

function safeSession(sessionId) {
  return String(sessionId || 'unknown').replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 120);
}

function statePath(kind, sessionId) {
  return path.join(os.tmpdir(), kind, `${safeSession(sessionId)}.json`);
}

function readState(kind, sessionId) {
  try {
    const value = JSON.parse(fs.readFileSync(statePath(kind, sessionId), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function writeState(kind, sessionId, value) {
  try {
    const file = statePath(kind, sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    safeWriteFileSync(file, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

module.exports = { safeSession, statePath, readState, writeState };
