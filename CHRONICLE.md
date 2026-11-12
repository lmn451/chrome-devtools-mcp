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

## 2026-11-03 — upstream sync

- Merged upstream `81a037939b19a3588ac6a35e06d576af706a3b57` as
  `b90ce1422dc93b514d7a8d61360a4e1dfd224708`. Resolved the
  `src/ToolHandler.ts` conflict by retaining fork resource-loader and shared
  page trace guards while adding upstream non-Error exception normalization;
  also merged the upstream whitespace-sensitive snapshot fix and dependency
  updates.
- Local verification passed: `npm run sync`, build, CLI/docs/metrics
  generation, format/check-format, focused ToolHandler/snapshot/proxy/HTTP/
  telemetry/performance tests, full serial suites on Node 22.21.1, 24.11.1,
  and 26.7.0, bundle, notices, and the 1% memory profile (maximum measured
  growth 0.60%). Bundle emitted non-fatal Rollup `this`/circular-dependency
  warnings.
- Exact-SHA Actions passed on `b90ce142`: compile/tests on Node 22/24/26
  (run `41673856433`), presubmit (run `41673856428`), and memory-leak test
  (run `41673856732`). Sync workflow run `41675056247` passed after the
  scheduled run `41658702216` reported the now-resolved ToolHandler conflict.
- Post-push fetch verified `origin/main` at
  `b90ce1422dc93b514d7a8d61360a4e1dfd224708`; live upstream is an ancestor
  and upstream missing count is zero.

## 2026-11-04 — upstream sync

- Fresh fetch: `origin/main` `c0f8b729e7025e7a4627126dc62f106a261851ae`; `upstream/main` `0877ee00d2e43c1c04bba275e7d08cc1033e36e9`, including the frontend pin update to `473d7d4` and logpoints feature.
- Merged upstream as `8523b00bac20bf3799f7aa93cb5fc57c126bf3a5`. Resolved the `src/McpPage.ts` conflict by retaining fork async trace/disposal behavior and upstream logpoint manager lifecycle; frontend gitlink matches upstream.
- Local verification passed: `npm run sync`, build, CLI/docs/metrics generation, format/diff checks, bundle, notices (2 passed), and focused logpoint/McpPage/console tests (169 passed). Rollup emitted non-fatal `this`/circular-dependency warnings.
- Local browser caveat: APK Chromium was `156.0.8078.79`, not the cached Puppeteer-pinned `156.0.8078.47`; on the APK build, the shared-page HTTP screenshot test timed out and the very tall full-page screenshot returned `Page is too large`. The pinned browser could not launch under gcompat (`unsupported relocation type 1032`), so these local browser results are not treated as code-pass evidence.
- Exact-SHA Actions passed on `8523b00`: compile/tests on Node 22/24/26 and required tests (run `41911866592`); presubmit format/docs checks (run `41911866544`); memory-leak tests (run `41911866571`). All runs completed successfully on the exact SHA.
- Post-push fetch verified `origin/main` at `8523b00bac20bf3799f7aa93cb5fc57c126bf3a5`; live `upstream/main` is an ancestor and upstream missing count is zero.

## 2026-11-07 — upstream sync

- Fresh fetch: `origin/main` `03a15dbb5d361f65bd2136ed5c01a76bc4a0dfc5`; `upstream/main` `0b37364dc0a88a804c6d73d3335e776adc7f33c4`, 16 commits ahead. Merged upstream as `1beef67d63b0b1e79d00f57f3d01112d568d7fe8`; the DevTools frontend gitlink matches `6629a207ee73e9e18cfa13505b22e3c1ab52f3d6`. Retained fork HTTP/proxy behavior and shared-page trace safeguards while resolving upstream build/test changes.
- Local checks passed: `npm run sync`, native GN/Ninja build (369/369 targets), CLI/docs/metrics generation, `npm run check-format`, and focused ToolHandler/performance tests. Local Rollup bundle/notices could not complete on the ARM64/musl host (Node heap limit); the pinned Chrome was unavailable locally.
- Exact-SHA Actions passed on `1beef67`: compile/tests including bundle and notices on Node 22/24/26 (run `42390789920`), presubmit (run `42390790049`), and memory-leak test (run `42390790133`).
- Post-push fetch verified `origin/main` at `1beef67d63b0b1e79d00f57f3d01112d568d7fe8`; live `upstream/main` is an ancestor and upstream missing count is zero.

## 2026-11-10 — upstream sync

- Fresh fetch: fork `origin/main` was `007b63200df3e9a9c268da866fdb7d0b0e5dedb0`; upstream `main` was `589f43caa3fabcc8c65f479003d3e9dc779ca78e`. Prepared the merge with DevTools frontend gitlink `ff77a8e8961a0b468d29affea6392eac22a93b5b`.
- Local checks passed: `gclient sync --nohooks`, GN generation, `npm run build -- -j4` (exit 0; 1,793.5s), CLI/docs/metrics generation, `npm run check-format`, and focused CLI-imports/comments/update-check/URL/config-options/telemetry tests. Temporary ARM/musl and QEMU wrappers were removed; all original binary hashes were verified restored.
- The full local `test:no-build` suite is not counted as passing: browser tests could not launch the pinned Puppeteer Chrome at `~/.cache/puppeteer/chrome/linux_arm-156.0.8078.47/chrome-linux-arm64/chrome` (ENOENT). Exact-SHA CI must cover browser, bundle/notices, and memory checks.
- Scheduled sync run `42844890042` merged upstream but its push was rejected when `GITHUB_TOKEN` tried to update `.github/workflows/pre-release.yml` without `workflows` permission. The local authenticated `spacex-hermes` token has workflow scope for this one-time push; future scheduled updates to workflow files need a suitably permissioned GitHub App token or PAT secret.
- At the time of the scheduled run, exact-SHA Actions and post-push live-ref verification were pending; resolved by the follow-up recorded below.

## 2026-11-11 — complete upstream sync

- Upstream advanced from `589f43caa3fabcc8c65f479003d3e9dc779ca78e` to `1d692d31ae370105afcf4d826dc36f1c4c22e21a`, including page-scoped network mocks and the DevTools frontend pin update `ff77a8e8961a0b468d29affea6392eac22a93b5b` → `a61ed5b9cf3d1c4aabfa2152ba6b0c994509f148`. Merged as `ed93895a8358bb449381fae4feaae31334329948` (parents: prior fork sync `38f6adb8cd012aef20fd32e9cb4caf1b8ab46c3e` and upstream `1d692d31...`). Resolved `McpPage.ts` and `tools/performance.ts` while preserving shared-page network-manager leases and trace ownership.
- Local validation passed on the merged tree: full GN/Ninja checked build (360/360), focused rebuilds after final source/test edits (5/5 and 2/2), CLI/docs/metrics generation, `npm run check-format`, `git diff --check`, focused network/McpPage tests, and the fallback regression test. The broader local browser-dependent subset could not launch pinned Puppeteer Chrome on this postmarketOS/musl host (ENOENT); exact-SHA CI covered it.
- The first pushed merge SHA exposed a test-fixture call-sequence bug: `init()` had already called `isClosed()` before the Sinon sequence was configured. Reset stub history in `tests/McpContext.test.ts`; the focused test passed locally. Follow-up commit: `2f021095759340a573138fd51b00c1eac2b686a6`.
- Exact-SHA Actions passed on `2f02109`: compile/tests including browser, bundle, and notices on Node 22/24/26 (run `42914575378`); docs and format presubmit (`42914575203`); memory-leak tests (`42914575149`).
- Post-push fetch verified `origin/main` at `2f021095759340a573138fd51b00c1eac2b686a6`; live `upstream/main` `1d692d31ae370105afcf4d826dc36f1c4c22e21a` is an ancestor, with zero upstream commits missing (65 fork-only commits ahead).

## 2026-11-12 — upstream sync (CI blocked)

- Merged upstream `83d2ba4dde9663a8cd0bdb8af6c99fea50726003` as `93e151142b57604ed1f135d81046755c6636d357` (parents: prior fork `ab1421e126baaf654abe70f000d55c7d6a9ed357` and upstream `83d2ba4...`). The DevTools frontend gitlink advanced from `a61ed5b9cf3d1c4aabfa2152ba6b0c994509f148` to `9f531666ae03a6b42faf12b038e45b0b80d286c8`; fork HTTP/proxy/resource-loader and shared-page lifecycle behavior were retained.
- Local checks passed: `npm run sync`, build/bundle, CLI/docs/metrics generation, `npm run format`, `npm run check-format`, `npm run test:notices:no-build`, and the focused mock-only suite (396 tests). The full browser-dependent suite is not counted as passing: pinned Puppeteer Chrome `157.0.8103.50` was unavailable on the AArch64/musl host.
- Independent static review of patch SHA-256 `1e197c42f32b12f05c64f9e6cc7703bfda0a31a0d2ac7b77d76c93dc50466ae1` passed with no security concerns or logic errors; two non-blocking suggestions remain (incomplete smaps measurements; treating retrieved DevTools comments as untrusted).
- Exact-SHA GitHub Actions runs: none. Workflow dispatch returned HTTP 422, “Actions has been disabled for this repository”; the current token cannot read/change Actions policy (403). Exact-SHA CI remains unavailable, so this sync is not considered fully validated.
- Fresh fetch verified `origin/main` at `93e151142b57604ed1f135d81046755c6636d357`, `upstream/main` at `83d2ba4dde9663a8cd0bdb8af6c99fea50726003`, upstream is an ancestor, and zero upstream commits are missing (67 fork-only commits ahead).
