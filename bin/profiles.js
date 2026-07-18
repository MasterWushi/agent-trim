'use strict';

const DEFAULTS = Object.freeze({ pass: 120, fail: 300, sidecarMin: 15000 });
const PROFILES = Object.freeze({
  'interactive-short': DEFAULTS,
  'interactive-long': Object.freeze({ pass: 80, fail: 220, sidecarMin: 10000 }),
  'autonomous-loop': Object.freeze({ pass: 50, fail: 180, sidecarMin: 8000 }),
  eval: Object.freeze({ pass: 60, fail: 200, sidecarMin: 8000 }),
  'final-verification': Object.freeze({ pass: 100, fail: 300, sidecarMin: 12000 }),
});

function positiveInt(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function effectiveCaps(profileName, env = process.env) {
  const name = profileName || env.TRIM_PROFILE;
  const profile = PROFILES[name] || DEFAULTS;
  return {
    profile: PROFILES[name] ? name : null,
    pass: positiveInt(env.TRIM_CAP_PASS) || profile.pass,
    fail: positiveInt(env.TRIM_CAP_FAIL) || positiveInt(env.TRIM_MAX_LINES) || profile.fail,
    sidecarMin: positiveInt(env.TRIM_SIDECAR_MIN) || profile.sidecarMin,
  };
}

module.exports = { DEFAULTS, PROFILES, effectiveCaps };
