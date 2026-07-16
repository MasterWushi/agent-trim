# Before/after: generic-only core (36cd003) vs structured strategies

One-time snapshot comparing the pre-strategy core against the current one on
the committed fixture corpus (sidecars disabled, same opts per fixture).
Bytes of compressed output; source-code and clean-short fixtures (pass-through
in both versions) omitted.

| fixture | input | old out | new out | change |
|---|---:|---:|---:|---|
| npm-install.txt | 29553 | 2621 | 2621 | = (generic) |
| build-pass-large.txt | 78705 | 6150 | 6150 | = (generic) |
| build-fail-large.txt | 46857 | 11843 | 11843 | = (generic) |
| tsc-errors.txt | 2515 | 2515 | 1229 | −51% (tsc grouping) |
| eslint.json | 8302 | 8302 | 620 | −93% (eslint-json) |
| vitest-fail.txt | 2884 | 1171 | 855 | −27% (jest-vitest) |
| jest-pass.txt | 3758 | 1058 | 470 | −56% (jest-vitest) |
| pytest-fail.txt | 3514 | 3514 | 1285 | −63% (pytest) |
| go-test-fail.txt | 2628 | 2628 | 487 | −81% (go-test) |
| git-diffstat.txt | 3000 | 3000 | 2071 | −31% (diffstat) |
| jsonl.log | 39701 | 15950 | 2082 | −87% (jsonl-log) |
| docker-build.txt | 52438 | 2634 | 2634 | = (generic) |
| adversarial-prose.txt | 19642 | 19825 | 19642 | old GREW output; fixed |
| progress-bars.txt | 8329 | 131 | 131 | = (generic) |
| unicode-crlf.txt | 9303 | 200 | 200 | = (generic) |

**Total: 311,129 input bytes → old 81,542 (ratio 0.262) → new 52,320 (ratio 0.168).**

Notes:

- The old core produced *larger-than-input* output on the adversarial-prose
  fixture (every line matches the signal pattern, so capping only added
  markers while cutting the tail). The new core detects mostly-signal output
  and leaves it whole.
- Old tsc/pytest/go-test/eslint numbers equal their input because those
  fixtures are small, dense, and signal-heavy — exactly the case generic
  line-capping cannot compress without hiding errors. Structured strategies
  compress them without losing a single unique diagnostic (asserted by
  `bench/run.js` mustKeep checks and `test/strategies.test.js`).
- The generic-path fixtures are byte-identical old vs new: the strategy layer
  changed nothing where it doesn't confidently detect a format.
