/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import sinon from 'sinon';

import {NetworkOverridesFormatter} from '../../src/formatters/NetworkOverridesFormatter.js';
import {
  acquireNetworkOverrideManager,
  releaseNetworkOverrideManager,
} from '../../src/NetworkOverrideManager.js';
import type {NetworkOverride} from '../../src/NetworkOverrideManager.js';
import {lighthouseAudit} from '../../src/tools/lighthouse.js';
import {startTrace, stopTrace} from '../../src/tools/performance.js';
import {
  releasePerformanceTrace,
  tryClaimPerformanceTrace,
} from '../../src/utils/PerformanceTraceRegistry.js';
import {
  createHandlerMocks,
  createMockRunnerResult,
  createMockServerConfig,
} from '../mocks.js';
import {loadTraceAsBuffer} from '../trace-processing/fixtures/load.js';

describe('network override measurements', () => {
  const overrides: NetworkOverride[] = [
    {
      id: 1,
      diagnostics: {hits: 0, errors: 0, navigations: 0},
      kind: 'file',
      urlPattern: 'https://example.com/app.js',
      responseFilePath: '/tmp/candidate.js',
      contentType: 'text/javascript',
    },
  ];
  const {warning} = new NetworkOverridesFormatter(overrides).toJSON();
  assert.ok(warning);

  async function addNetworkOverride(
    page: ReturnType<typeof createHandlerMocks>['page'],
  ): Promise<() => Promise<void>> {
    const owner = page;
    const manager = await acquireNetworkOverrideManager(
      page.pptrPage,
      owner,
      createMockServerConfig(),
    );
    const override = overrides[0];
    if (!override || override.kind !== 'file') {
      throw new Error('Expected a file test network override.');
    }
    await manager.mock(
      {
        kind: 'file',
        urlPattern: override.urlPattern,
        responseFilePath: override.responseFilePath,
        contentType: override.contentType,
        loadResponseFile: async () => new Uint8Array(),
      },
      owner,
    );
    return async () => {
      await releaseNetworkOverrideManager(page.pptrPage, owner);
    };
  }

  function claimRunningTrace(
    page: ReturnType<typeof createHandlerMocks>['page'],
  ): void {
    assert.ok(tryClaimPerformanceTrace(page.pptrPage, page));
    page.setIsRunningPerformanceTrace(true);
  }

  it('prints no measurement warning without overrides', () => {
    const formatter = new NetworkOverridesFormatter([]);
    assert.deepEqual(formatter.toJSON(), {overrides: []});
    assert.equal(formatter.toString(), '');
  });

  for (const fails of [false, true]) {
    it(
      'keeps override cache bypass after trace reload ' +
        (fails ? 'failure' : 'success'),
      async () => {
        const {page, context, response, args} = createHandlerMocks();
        const releaseOverride = await addNetworkOverride(page);
        try {
          page.pptrPage.url.returns('https://example.com/');
          const cacheCallsBeforeTrace = page.pptrPage.setCacheEnabled.callCount;
          if (fails) {
            page.pptrPage.goto
              .onSecondCall()
              .rejects(new Error('Reload failed'));
          }
          const action = startTrace(args).handler(
            {
              params: {reload: true, autoStop: false, ignoreCache: true},
              page,
            },
            response,
            context,
          );
          if (fails) {
            await assert.rejects(action, /Reload failed/);
          } else {
            await action;
          }
          assert.equal(
            page.pptrPage.setCacheEnabled.callCount,
            cacheCallsBeforeTrace,
          );
          sinon.assert.calledWithExactly(
            response.appendResponseLine.firstCall,
            warning,
          );
        } finally {
          await releaseOverride();
        }
      },
    );
  }

  it('warns about overrides when stopping a trace and saves the raw trace', async () => {
    const {page, context, response, args} = createHandlerMocks();
    const releaseOverride = await addNetworkOverride(page);
    const raw = loadTraceAsBuffer('basic-trace.json.gz');
    context.isRunningPerformanceTrace.returns(true);
    page.isRunningPerformanceTrace.returns(true);
    page.pptrPage.tracing.stop.resolves(raw);
    context.saveFile.resolves({filename: '/tmp/trace.json'});
    claimRunningTrace(page);
    try {
      await stopTrace(args).handler(
        {params: {filePath: '/tmp/trace.json'}, page},
        response,
        context,
      );
      sinon.assert.calledOnceWithExactly(
        context.saveFile,
        raw,
        '/tmp/trace.json',
        '.json',
      );
      sinon.assert.calledWithExactly(
        response.appendResponseLine.firstCall,
        warning,
      );
      const trace = context.storeTraceRecording.firstCall.args[0];
      sinon.assert.calledOnceWithExactly(response.attachTraceSummary, trace);
      assert.deepEqual(page.setIsRunningPerformanceTrace.args, [
        [true],
        [false],
      ]);
    } finally {
      releasePerformanceTrace(page.pptrPage, page);
      await releaseOverride();
    }
  });

  it('warns about overrides even when trace parsing fails', async () => {
    const {page, context, response, args} = createHandlerMocks();
    const releaseOverride = await addNetworkOverride(page);
    context.isRunningPerformanceTrace.returns(true);
    page.isRunningPerformanceTrace.returns(true);
    page.pptrPage.tracing.stop.resolves(new TextEncoder().encode('{}'));
    context.saveFile.resolves({filename: '/tmp/trace.json'});
    claimRunningTrace(page);
    try {
      await assert.rejects(
        stopTrace(args).handler(
          {params: {filePath: '/tmp/trace.json'}, page},
          response,
          context,
        ),
        /parsing the trace/,
      );
      sinon.assert.calledWithExactly(
        response.appendResponseLine.firstCall,
        warning,
      );
      sinon.assert.notCalled(context.storeTraceRecording);
    } finally {
      releasePerformanceTrace(page.pptrPage, page);
      await releaseOverride();
    }
  });

  it('warns about overrides in Lighthouse output and saved reports', async () => {
    const {page, context, response, args} = createHandlerMocks();
    const result = createMockRunnerResult({runWarnings: []});
    page.listNetworkMocks.returns(overrides);
    page.lighthouseSnapshot.resolves(result);
    context.saveTemporaryFile.resolves({filepath: '/tmp/report.json'});
    await lighthouseAudit(args).handler(
      {params: {mode: 'snapshot'}, page},
      response,
      context,
    );
    assert.deepEqual(result.lhr.runWarnings, [warning]);
    sinon.assert.calledOnceWithExactly(response.appendResponseLine, warning);
    const jsonReport = context.saveTemporaryFile.firstCall.args[0];
    assert.match(
      new TextDecoder().decode(jsonReport),
      /intercept every request/,
    );
    sinon.assert.notCalled(page.lighthouseNavigation);
  });
});
