# CHRONICLE

## 2026-10-26 — chrome-devtools-mcp fork

- Merged upstream commit `b8697c3e51155d08862c755c8f7873d35f9ef291` as `3ee8fa4845d8ebf35d12398edb020e95d5799b6d`, updating the pinned DevTools frontend from `7be69dfa5dd9cdd753ef832a4cf55b8f253fb6aa` to `34926d0802182647cad7a1b5fe0590f3e3d66346`; a fresh fetch confirmed live `upstream/main` is an ancestor of fork `main`.
- Implemented process-wide performance-trace ownership and page-operation coordination for shared Puppeteer pages, including fail-fast trace startup during service-worker evaluation, disposal/close/mutation guards, and setup cancellation cleanup. Independent static audit of patch `7edc0d243454f4d340d3d6141cca74fc90f74e040c23834255330fea46143f0b` found no actionable blockers.
- Commits: functional fix `70645f182ffc1296f6b32c592471bdcbfe295f46`; regression tests `eae9605a834d771608ea74c0381db6e5b1c4149e`; manual-CI dispatch support `c42875af1acf1b9ae885dbaeda1272b19029be9f`.
- Local verification passed on code/workflow head `c42875af1acf1b9ae885dbaeda1272b19029be9f`: `npm run sync`, `npm run build`, `npm run cli:generate`, `npm run docs:generate`, `npm run update-metrics`, `npm run check-format`, `git diff --check`, full serial test suite, bundle, and notice tests. Bundle completed with circular-dependency warnings.
- Published to `https://github.com/lmn451/chrome-devtools-mcp` (`origin/main`); post-push fetch confirmed `origin/main` matched `c42875af1acf1b9ae885dbaeda1272b19029be9f`, upstream missing count was zero, and the worktree was clean.
- GitHub Actions is disabled for this repository. Push events for the code/test commits did not create runs; added `workflow_dispatch` to the test, presubmit, and memory-leak workflows, but manual dispatch returned HTTP 422 (`Actions has been disabled for this repository`). The authenticated account has push access but not admin access, so I could not re-enable Actions. CI remains unverified; local verification above passed.
