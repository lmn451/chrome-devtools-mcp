# CHRONICLE

## 2026-10-26 — chrome-devtools-mcp fork

- Merged upstream commit `b8697c3e51155d08862c755c8f7873d35f9ef291` as `3ee8fa4845d8ebf35d12398edb020e95d5799b6d`, updating the pinned DevTools frontend from `7be69dfa5dd9cdd753ef832a4cf55b8f253fb6aa` to `34926d0802182647cad7a1b5fe0590f3e3d66346`; a fresh fetch confirmed live `upstream/main` is an ancestor of fork `main`.
- Implemented process-wide performance-trace ownership and page-operation coordination for shared Puppeteer pages, including fail-fast trace startup during service-worker evaluation, disposal/close/mutation guards, and setup cancellation cleanup. Independent static audit of patch `7edc0d243454f4d340d3d6141cca74fc90f74e040c23834255330fea46143f0b` found no actionable blockers.
- Commits: functional fix `70645f182ffc1296f6b32c592471bdcbfe295f46`; regression tests `eae9605a834d771608ea74c0381db6e5b1c4149e`; manual-CI dispatch support `c42875af1acf1b9ae885dbaeda1272b19029be9f`.
- Local verification passed on code/workflow head `c42875af1acf1b9ae885dbaeda1272b19029be9f`: `npm run sync`, `npm run build`, `npm run cli:generate`, `npm run docs:generate`, `npm run update-metrics`, `npm run check-format`, `git diff --check`, full serial test suite, bundle, and notice tests. Bundle completed with circular-dependency warnings.
- Published to `https://github.com/lmn451/chrome-devtools-mcp` (`origin/main`); post-push fetch confirmed `origin/main` matched `c42875af1acf1b9ae885dbaeda1272b19029be9f`, upstream missing count was zero, and the worktree was clean.
- At the time, push events did not create runs and manual dispatch returned HTTP 422 (`Actions has been disabled for this repository`); the authenticated account had push access but not admin access. This was time-specific, not a permanent repository state.

## 2026-10-28 — stabilize Node 22/24 test execution

- GitHub Actions run `40743449681` ran on `af371dbc0ef81c867754fdd22916b307e4f1178d`: the shared-browser HTTP multi-client test timed out after 120 seconds on Node 22/24; Node 26 passed. Presubmit `40743513820` and memory-leak run `40743519608` passed.
- Reproduced locally with Node 22.23.3: the full suite at `--test-concurrency=2` hit the same timeout, while serial full suites passed on Node 22.23.3 and 24.21.0. The isolated HTTP multi-client test also passed on both runtimes.
- Committed as `84a28a6` in `.github/workflows/run-tests.yml`: serialize tests on Windows and Node versions below 26, retaining parallel execution for Ubuntu/Node 26. `npm run check-format`, `git diff --check`, YAML parsing, and matrix-argument rendering passed. No exact-SHA Actions run existed for this local change at that point.
- At that point, no push or upstream merge had been performed: `origin/main` was `af371dbc0ef81c867754fdd22916b307e4f1178d`, `upstream/main` was `bc0d93ee2df6f2410d9e9704903c3547acae7c9a`; the fork was 47 commits ahead of upstream, while upstream was 4 commits ahead of the fork.

## 2026-10-29 — upstream sync

- Fresh fetch: `origin/main` `af371dbc0ef81c867754fdd22916b307e4f1178d`; `upstream/main` `3c609da38a39067f4a0b885ce81968eb958b76a`. The fork had 47 fork-only commits; upstream had 8 commits not yet in the fork.
- Merged upstream `3c609da38a39067f4a0b885ce81968eb958b76a` as merge commit `c203188d40ab291c2a7aa53ce736d41bc995a709` with no merge conflicts. Retained the fork HTTP server, stdio proxy, shared-page performance-trace registry, HTTP tests, and manual workflow dispatches.
- Carried the Node 22/24 serial-test adjustment forward as `9589caa`; the merge worktree also contains the fork's 47 commits.
- Local verification passed: `npm ci`; build, CLI/docs/metrics generation, formatting and `git diff --check`; bundle (with non-fatal circular-dependency warnings); full suites on Node 22.23.3 and 24.21.0 (1,820 passed, 2 skipped, 0 failed each); notice tests (2 passed); memory profile with 1% threshold (exit 0).
- At the time of this entry, the sync is prepared locally; push and exact-SHA GitHub Actions verification are still pending.

## 2026-10-30 — upstream sync

- Merged upstream `8d009e854f8aa55b1ec31628e836d4d4731b8ec8` as
  `86f0b0c2b64c8cf7743fa0c564a512b08a6707d1`, updating the DevTools frontend
  pin from `1212f1bf37d47640deaef2911db0be022637c89d` to
  `9447cb6aad3f414539ca9483b72ec7a24744c04a`.
- Local checks passed: sync, build, CLI/docs/metrics generation,
  format/check-format, diff check, bundle, notices, and the full serial test
  suite; focused browser tests passed 34/34.
- Exact-SHA Actions passed on `86f0b0c`: compile/tests on Node 22/24/26
  (run `41055915313`), presubmit (run `41055915234`), and memory-leak test
  (run `41055915386`).
- Post-push fetch verified `origin/main` at
  `86f0b0c2b64c8cf7743fa0c564a512b08a6707d1`; live upstream is an ancestor
  and upstream missing count is zero.
