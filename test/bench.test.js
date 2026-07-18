'use strict';
// Regression gate: the committed benchmark baseline must hold — no false
// elisions, and no fixture's compressed size growing >10% past baseline.
const { execFileSync } = require('child_process');
const path = require('path');

execFileSync(process.execPath, [path.join(__dirname, '..', 'bench', 'run.js'), '--check'], {
  stdio: 'inherit',
});
execFileSync(process.execPath, [path.join(__dirname, '..', 'bench', 'efficiency.js'), '--check'], { stdio: 'inherit' });
execFileSync(process.execPath, [path.join(__dirname, '..', 'bench', 'perf.js'), '--check'], { stdio: 'inherit' });
console.log('bench.test.js: baseline check passed');
