/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it, beforeEach} from 'node:test';
import zlib from 'node:zlib';

import sinon from 'sinon';

import {
  analyzeInsight,
  startTrace,
  stopTrace,
} from '../../src/tools/performance.js';
import {navigatePage} from '../../src/tools/pages.js';
import {
  parseRawTraceBuffer,
  type TraceResult,
  traceResultIsSuccess,
} from '../../src/processors/PerformanceTrace.js';
import {DevTools} from '../../src/third_party/index.js';
import {
  finishPageClose,
  PERFORMANCE_TRACE_GLOBAL_LOCK_BUSY_MESSAGE,
  PERFORMANCE_TRACE_PAGE_CLOSING_MESSAGE,
  tryBeginPageClose,
  tryClaimPerformanceTrace,
  releasePerformanceTrace,
  withPerformanceTraceGlobalLock,
  withPerformanceTracePageLock,
} from '../../src/utils/PerformanceTraceRegistry.js';
import {
  createHandlerMocks,
  createMockMcpContext,
  createMockMcpPage,
  createMockMcpResponse,
} from '../mocks.js';
import {loadTraceAsBuffer} from '../trace-processing/fixtures/load.js';
import {withMcpContext} from '../utils.js';

describe('performance', () => {
  beforeEach(() => {
    sinon.stub(globalThis, 'fetch').callsFake(async url => {
      const cruxEndpoint =
        'https://chromeuxreport.googleapis.com/v1/records:queryRecord';
      if (url.toString().startsWith(cruxEndpoint)) {
        return new Response(JSON.stringify(cruxResponseFixture()), {
          status: 200,
          headers: {'Content-Type': 'application/json'},
        });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
  });

  describe('performance_start_trace', () => {
    it('fails fast when the global trace lock is busy without holding the page lock', async () => {
      const {page, context, response, args} = createHandlerMocks();
      context.isRunningPerformanceTrace.returns(false);
      context.isPerformanceTraceEnabled.returns(true);

      let releaseGlobalLock!: () => void;
      let enterGlobalLock!: () => void;
      const globalLockEntered = new Promise<void>(resolve => {
        enterGlobalLock = resolve;
      });
      const globalLockGate = new Promise<void>(resolve => {
        releaseGlobalLock = resolve;
      });
      const lockPromise = withPerformanceTraceGlobalLock(async () => {
        enterGlobalLock();
        await globalLockGate;
      });
      let tracePromise: Promise<void> | undefined;
      let navigationPromise: Promise<void> | undefined;
      let navigationStarted = false;
      try {
        await globalLockEntered;
        tracePromise = startTrace(args).handler(
          {
            params: {reload: false, autoStop: false},
            page,
          },
          response,
          context,
        );
        await tracePromise;

        page.pptrPage.goto.callsFake(async () => {
          navigationStarted = true;
          return null;
        });
        navigationPromise = navigatePage(args).handler(
          {params: {url: 'https://example.com'}, page},
          response,
          context,
        );
        await navigationPromise;

        assert.strictEqual(navigationStarted, true);
        sinon.assert.calledWith(
          response.appendResponseLine,
          PERFORMANCE_TRACE_GLOBAL_LOCK_BUSY_MESSAGE,
        );
        sinon.assert.notCalled(page.pptrPage.tracing.start);
      } finally {
        releaseGlobalLock();
        await Promise.all([
          lockPromise.catch(() => undefined),
          tracePromise?.catch(() => undefined),
          navigationPromise?.catch(() => undefined),
        ]);
        page.setIsRunningPerformanceTrace(false);
        releasePerformanceTrace(page.pptrPage, page);
      }
    });

    it('does not deadlock when a page script awaits a service-worker evaluation', async () => {
      const {page, context, response, args} = createHandlerMocks();
      context.isRunningPerformanceTrace.returns(false);
      context.isPerformanceTraceEnabled.returns(true);

      let enterPageScript!: () => void;
      const pageScriptEntered = new Promise<void>(resolve => {
        enterPageScript = resolve;
      });
      const workerEvaluationFinished = Promise.withResolvers<void>();
      const pageScriptPromise = withPerformanceTracePageLock(
        page.pptrPage,
        async () => {
          enterPageScript();
          await workerEvaluationFinished.promise;
        },
      );
      let workerPromise: Promise<void> | undefined;
      let tracePromise: Promise<void> | undefined;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        await pageScriptEntered;
        tracePromise = startTrace(args).handler(
          {
            params: {reload: false, autoStop: false},
            page,
          },
          response,
          context,
        );
        await new Promise<void>(resolve => setImmediate(resolve));

        workerPromise = withPerformanceTraceGlobalLock(async () => {});
        void workerPromise.then(() => workerEvaluationFinished.resolve());
        const completed = await Promise.race([
          Promise.all([workerPromise, pageScriptPromise, tracePromise]).then(
            () => true,
          ),
          new Promise<boolean>(resolve => {
            timeoutHandle = setTimeout(() => resolve(false), 1_000);
          }),
        ]);

        assert.strictEqual(completed, true);
        sinon.assert.calledOnce(page.pptrPage.tracing.start);
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        workerEvaluationFinished.resolve();
        await Promise.all([
          workerPromise?.catch(() => undefined),
          pageScriptPromise.catch(() => undefined),
          tracePromise?.catch(() => undefined),
        ]);
        page.setIsRunningPerformanceTrace(false);
        releasePerformanceTrace(page.pptrPage, page);
      }
    });

    it('does not start a trace after performance tools are disabled while queued', async () => {
      const {page, context, response, args} = createHandlerMocks();
      context.isRunningPerformanceTrace.returns(false);
      context.isPerformanceTraceEnabled.returns(true);

      let releasePageLock!: () => void;
      let enterPageLock!: () => void;
      const pageLockEntered = new Promise<void>(resolve => {
        enterPageLock = resolve;
      });
      const pageLockGate = new Promise<void>(resolve => {
        releasePageLock = resolve;
      });
      const lockPromise = withPerformanceTracePageLock(
        page.pptrPage,
        async () => {
          enterPageLock();
          await pageLockGate;
        },
      );
      let tracePromise: Promise<void> | undefined;
      try {
        await pageLockEntered;
        tracePromise = startTrace(args).handler(
          {
            params: {reload: false, autoStop: false},
            page,
          },
          response,
          context,
        );
        await new Promise<void>(resolve => setImmediate(resolve));
        sinon.assert.notCalled(page.pptrPage.tracing.start);

        context.isPerformanceTraceEnabled.returns(false);
        releasePageLock();
        await Promise.all([lockPromise, tracePromise]);

        sinon.assert.notCalled(page.pptrPage.tracing.start);
        sinon.assert.calledWith(
          response.appendResponseLine,
          'Error: performance tools are disabled.',
        );
      } finally {
        releasePageLock();
        await Promise.all([
          lockPromise.catch(() => undefined),
          tracePromise?.catch(() => undefined),
        ]);
        page.setIsRunningPerformanceTrace(false);
        releasePerformanceTrace(page.pptrPage, page);
      }
    });

    it('does not start a trace after its page is disposed while queued', async () => {
      const {page, context, response, args} = createHandlerMocks();
      context.isRunningPerformanceTrace.returns(false);
      context.isPerformanceTraceEnabled.returns(true);

      let releasePageLock!: () => void;
      let enterPageLock!: () => void;
      const pageLockEntered = new Promise<void>(resolve => {
        enterPageLock = resolve;
      });
      const pageLockGate = new Promise<void>(resolve => {
        releasePageLock = resolve;
      });
      const lockPromise = withPerformanceTracePageLock(
        page.pptrPage,
        async () => {
          enterPageLock();
          await pageLockGate;
        },
      );
      let tracePromise: Promise<void> | undefined;
      try {
        await pageLockEntered;
        tracePromise = startTrace(args).handler(
          {
            params: {reload: false, autoStop: false},
            page,
          },
          response,
          context,
        );
        await new Promise<void>(resolve => setImmediate(resolve));
        page.isClosed.returns(true);

        releasePageLock();
        await Promise.all([lockPromise, tracePromise]);

        sinon.assert.notCalled(page.pptrPage.tracing.start);
        sinon.assert.calledWith(
          response.appendResponseLine,
          PERFORMANCE_TRACE_PAGE_CLOSING_MESSAGE,
        );
      } finally {
        releasePageLock();
        await Promise.all([
          lockPromise.catch(() => undefined),
          tracePromise?.catch(() => undefined),
        ]);
        page.setIsRunningPerformanceTrace(false);
        releasePerformanceTrace(page.pptrPage, page);
      }
    });

    it('cancels setup when the page is disposed during the initial navigation', async () => {
      const {page, context, response, args} = createHandlerMocks();
      context.isRunningPerformanceTrace.returns(false);
      context.isPerformanceTraceEnabled.returns(true);
      page.pptrPage.url.returns('https://trace.example/');

      let releaseNavigation!: () => void;
      let enterNavigation!: () => void;
      const navigationEntered = new Promise<void>(resolve => {
        enterNavigation = resolve;
      });
      const navigationGate = new Promise<void>(resolve => {
        releaseNavigation = resolve;
      });
      page.pptrPage.goto.callsFake(async url => {
        if (url === 'about:blank') {
          enterNavigation();
          await navigationGate;
        }
        return null;
      });

      let tracePromise: Promise<void> | undefined;
      try {
        tracePromise = startTrace(args).handler(
          {
            params: {reload: true, autoStop: false},
            page,
          },
          response,
          context,
        );
        await navigationEntered;
        page.isClosed.returns(true);
        releaseNavigation();
        await tracePromise;

        sinon.assert.calledOnceWithExactly(page.pptrPage.goto, 'about:blank', {
          waitUntil: 'load',
        });
        sinon.assert.notCalled(page.pptrPage.tracing.start);
        sinon.assert.calledWith(
          response.appendResponseLine,
          PERFORMANCE_TRACE_PAGE_CLOSING_MESSAGE,
        );
        sinon.assert.calledWith(page.setIsRunningPerformanceTrace, false);
      } finally {
        releaseNavigation();
        await tracePromise?.catch(() => undefined);
        page.setIsRunningPerformanceTrace(false);
        releasePerformanceTrace(page.pptrPage, page);
      }
    });

    it('stops trace setup if disposed while tracing starts', async () => {
      const {page, context, response, args} = createHandlerMocks();
      context.isRunningPerformanceTrace.returns(false);
      context.isPerformanceTraceEnabled.returns(true);
      page.pptrPage.url.returns('https://trace.example/');

      let releaseTraceStart!: () => void;
      let enterTraceStart!: () => void;
      const traceStartEntered = new Promise<void>(resolve => {
        enterTraceStart = resolve;
      });
      const traceStartGate = new Promise<void>(resolve => {
        releaseTraceStart = resolve;
      });
      page.pptrPage.tracing.start.callsFake(async () => {
        enterTraceStart();
        await traceStartGate;
      });

      let tracePromise: Promise<void> | undefined;
      try {
        tracePromise = startTrace(args).handler(
          {
            params: {reload: true, autoStop: false},
            page,
          },
          response,
          context,
        );
        await traceStartEntered;
        page.isClosed.returns(true);
        releaseTraceStart();
        await tracePromise;

        sinon.assert.calledOnceWithExactly(page.pptrPage.goto, 'about:blank', {
          waitUntil: 'load',
        });
        sinon.assert.calledOnce(page.pptrPage.tracing.stop);
        sinon.assert.calledWith(
          response.appendResponseLine,
          PERFORMANCE_TRACE_PAGE_CLOSING_MESSAGE,
        );
        sinon.assert.calledWith(page.setIsRunningPerformanceTrace, false);
      } finally {
        releaseTraceStart();
        await tracePromise?.catch(() => undefined);
        page.setIsRunningPerformanceTrace(false);
        releasePerformanceTrace(page.pptrPage, page);
      }
    });

    it('stops trace setup if performance tools are disabled while tracing starts', async () => {
      const {page, context, response, args} = createHandlerMocks();
      context.isRunningPerformanceTrace.returns(false);
      context.isPerformanceTraceEnabled.returns(true);
      page.pptrPage.url.returns('https://trace.example/');

      let releaseTraceStart!: () => void;
      let enterTraceStart!: () => void;
      const traceStartEntered = new Promise<void>(resolve => {
        enterTraceStart = resolve;
      });
      const traceStartGate = new Promise<void>(resolve => {
        releaseTraceStart = resolve;
      });
      page.pptrPage.tracing.start.callsFake(async () => {
        enterTraceStart();
        await traceStartGate;
      });

      let tracePromise: Promise<void> | undefined;
      try {
        tracePromise = startTrace(args).handler(
          {
            params: {reload: true, autoStop: false},
            page,
          },
          response,
          context,
        );
        await traceStartEntered;
        context.isPerformanceTraceEnabled.returns(false);
        releaseTraceStart();
        await tracePromise;

        sinon.assert.calledOnceWithExactly(page.pptrPage.goto, 'about:blank', {
          waitUntil: 'load',
        });
        sinon.assert.calledOnce(page.pptrPage.tracing.stop);
        sinon.assert.calledWith(
          response.appendResponseLine,
          'Error: performance tools are disabled.',
        );
        sinon.assert.calledWith(page.setIsRunningPerformanceTrace, false);
      } finally {
        releaseTraceStart();
        await tracePromise?.catch(() => undefined);
        page.setIsRunningPerformanceTrace(false);
        releasePerformanceTrace(page.pptrPage, page);
      }
    });

    it('restores the original URL when disabled during the initial navigation', async () => {
      const {page, context, response, args} = createHandlerMocks();
      context.isRunningPerformanceTrace.returns(false);
      context.isPerformanceTraceEnabled.returns(true);
      page.pptrPage.url.returns('https://trace.example/');

      let releaseNavigation!: () => void;
      let enterNavigation!: () => void;
      const navigationEntered = new Promise<void>(resolve => {
        enterNavigation = resolve;
      });
      const navigationGate = new Promise<void>(resolve => {
        releaseNavigation = resolve;
      });
      page.pptrPage.goto.callsFake(async url => {
        if (String(url) === 'about:blank') {
          page.pptrPage.url.returns('about:blank');
          enterNavigation();
          await navigationGate;
        } else {
          page.pptrPage.url.returns(String(url));
        }
        return null;
      });

      let tracePromise: Promise<void> | undefined;
      try {
        tracePromise = startTrace(args).handler(
          {
            params: {reload: true, autoStop: false},
            page,
          },
          response,
          context,
        );
        await navigationEntered;
        context.isPerformanceTraceEnabled.returns(false);
        releaseNavigation();
        await tracePromise;

        sinon.assert.calledTwice(page.pptrPage.goto);
        sinon.assert.calledWith(page.pptrPage.goto, 'about:blank', {
          waitUntil: 'load',
        });
        sinon.assert.calledWith(page.pptrPage.goto, 'https://trace.example/', {
          waitUntil: ['load'],
        });
        sinon.assert.notCalled(page.pptrPage.tracing.start);
        sinon.assert.calledWith(
          response.appendResponseLine,
          'Error: performance tools are disabled.',
        );
      } finally {
        releaseNavigation();
        await tracePromise?.catch(() => undefined);
        page.setIsRunningPerformanceTrace(false);
        releasePerformanceTrace(page.pptrPage, page);
      }
    });

    it('does not start a trace after a page close is reserved', async () => {
      const {page, context, response, args} = createHandlerMocks();
      const closeOwner = {};
      assert.ok(tryBeginPageClose(page.pptrPage, closeOwner));

      try {
        await startTrace(args).handler(
          {
            params: {reload: false, autoStop: false},
            page,
          },
          response,
          context,
        );

        sinon.assert.calledOnceWithExactly(
          response.appendResponseLine,
          PERFORMANCE_TRACE_PAGE_CLOSING_MESSAGE,
        );
        sinon.assert.notCalled(page.pptrPage.tracing.start);
      } finally {
        finishPageClose(page.pptrPage);
      }
    });

    it('starts a trace recording and reloads the page by default', async () => {
      const {page, context, response, args} = createHandlerMocks();
      context.isRunningPerformanceTrace.returns(false);
      page.pptrPage.url.returns('https://trace.example/');

      await startTrace(args).handler(
        {
          params: {reload: true, autoStop: false},
          page,
        },
        response,
        context,
      );

      sinon.assert.calledTwice(page.pptrPage.goto);
      sinon.assert.calledWithExactly(
        page.pptrPage.goto.firstCall,
        'about:blank',
        {waitUntil: 'load'},
      );
      sinon.assert.calledWithExactly(
        page.pptrPage.goto.secondCall,
        'https://trace.example/',
        {waitUntil: ['load']},
      );
      sinon.assert.calledOnceWithExactly(page.pptrPage.tracing.start, {
        categories: [
          '-*',
          ...DevTools.TracingDefaultCategories,
          ...DevTools.TracingOptionalCategories.JsSampling,
          ...DevTools.TracingOptionalCategories.Screenshot,
        ],
        bufferSize: 1200 * 1000,
      });
      sinon.assert.calledOnceWithExactly(
        page.setIsRunningPerformanceTrace,
        true,
      );
      sinon.assert.calledWithMatch(
        response.appendResponseLine,
        sinon.match(/The performance trace is being recorded/),
      );
    });

    it('does not navigate or stop a trace owned by another context', async () => {
      const {
        page: firstPage,
        context: firstContext,
        response: firstResponse,
        args,
      } = createHandlerMocks();
      const secondPage = createMockMcpPage({pptrPage: firstPage.pptrPage});
      const secondContext = createMockMcpContext({selectedPage: secondPage});
      const secondResponse = createMockMcpResponse();
      firstContext.isRunningPerformanceTrace.returns(false);
      secondContext.isRunningPerformanceTrace.returns(false);

      let firstTraceRunning = false;
      firstPage.isRunningPerformanceTrace.callsFake(() => firstTraceRunning);
      firstPage.setIsRunningPerformanceTrace.callsFake(isRunning => {
        firstTraceRunning = isRunning;
      });
      let secondTraceRunning = false;
      secondPage.isRunningPerformanceTrace.callsFake(() => secondTraceRunning);
      secondPage.setIsRunningPerformanceTrace.callsFake(isRunning => {
        secondTraceRunning = isRunning;
      });

      const traceData = loadTraceAsBuffer('basic-trace.json.gz');
      firstPage.pptrPage.tracing.start.onFirstCall().resolves();
      firstPage.pptrPage.tracing.start
        .onSecondCall()
        .rejects(new Error('Trace already running'));
      firstPage.pptrPage.tracing.stop.resolves(traceData);

      try {
        await startTrace(args).handler(
          {params: {reload: true, autoStop: false}, page: firstPage},
          firstResponse,
          firstContext,
        );

        await startTrace(args).handler(
          {params: {reload: true, autoStop: false}, page: secondPage},
          secondResponse,
          secondContext,
        );

        sinon.assert.calledOnce(firstPage.pptrPage.tracing.start);
        sinon.assert.calledTwice(firstPage.pptrPage.goto);
        sinon.assert.notCalled(firstPage.pptrPage.tracing.stop);
        sinon.assert.notCalled(secondPage.setIsRunningPerformanceTrace);
        sinon.assert.calledOnceWithExactly(
          secondResponse.appendResponseLine,
          'Error: a performance trace is already running. Use performance_stop_trace to stop it. Only one trace can be running at any given time.',
        );
      } finally {
        if (firstTraceRunning) {
          await stopTrace(args).handler(
            {params: {}, page: firstPage},
            firstResponse,
            firstContext,
          );
        }
      }
    });

    it('allows another session to start after the shared page trace stops', async () => {
      const {
        page: firstPage,
        context: firstContext,
        response: firstResponse,
        args,
      } = createHandlerMocks();
      const secondPage = createMockMcpPage({pptrPage: firstPage.pptrPage});
      const secondContext = createMockMcpContext({selectedPage: secondPage});
      const secondResponse = createMockMcpResponse();
      firstContext.isRunningPerformanceTrace.returns(false);
      secondContext.isRunningPerformanceTrace.returns(false);

      let firstTraceRunning = false;
      firstPage.isRunningPerformanceTrace.callsFake(() => firstTraceRunning);
      firstPage.setIsRunningPerformanceTrace.callsFake(isRunning => {
        firstTraceRunning = isRunning;
      });
      let secondTraceRunning = false;
      secondPage.isRunningPerformanceTrace.callsFake(() => secondTraceRunning);
      secondPage.setIsRunningPerformanceTrace.callsFake(isRunning => {
        secondTraceRunning = isRunning;
      });

      firstPage.pptrPage.tracing.stop.resolves(
        loadTraceAsBuffer('basic-trace.json.gz'),
      );

      try {
        await startTrace(args).handler(
          {params: {reload: false, autoStop: false}, page: firstPage},
          firstResponse,
          firstContext,
        );
        await stopTrace(args).handler(
          {params: {}, page: firstPage},
          firstResponse,
          firstContext,
        );

        await startTrace(args).handler(
          {params: {reload: false, autoStop: false}, page: secondPage},
          secondResponse,
          secondContext,
        );

        sinon.assert.calledTwice(firstPage.pptrPage.tracing.start);
        assert.strictEqual(secondTraceRunning, true);
      } finally {
        if (secondTraceRunning) {
          await stopTrace(args).handler(
            {params: {}, page: secondPage},
            secondResponse,
            secondContext,
          );
        }
      }
    });

    it('does not reload when reload is false', async () => {
      const {page, context, response, args} = createHandlerMocks();
      context.isRunningPerformanceTrace.returns(false);
      page.pptrPage.url.returns('https://trace.example/');

      await startTrace(args).handler(
        {
          params: {reload: false, autoStop: false},
          page,
        },
        response,
        context,
      );

      sinon.assert.calledOnce(page.pptrPage.tracing.start);
      sinon.assert.notCalled(page.pptrPage.goto);
      sinon.assert.calledOnceWithExactly(
        page.setIsRunningPerformanceTrace,
        true,
      );
    });

    it('disables the cache during the reload when ignoreCache is set', async () => {
      const {page, context, response, args} = createHandlerMocks();
      page.pptrPage.url.returns('https://cold-load.example/');

      await startTrace(args).handler(
        {params: {reload: true, autoStop: false, ignoreCache: true}, page},
        response,
        context,
      );

      const {goto, setCacheEnabled} = page.pptrPage;
      sinon.assert.calledTwice(setCacheEnabled);
      sinon.assert.calledWithExactly(setCacheEnabled.firstCall, false);
      sinon.assert.calledWithExactly(setCacheEnabled.secondCall, true);
      sinon.assert.calledWithExactly(
        goto.secondCall,
        'https://cold-load.example/',
        {waitUntil: ['load']},
      );
      assert.ok(setCacheEnabled.firstCall.calledAfter(goto.firstCall));
      assert.ok(setCacheEnabled.firstCall.calledBefore(goto.secondCall));
      assert.ok(setCacheEnabled.secondCall.calledAfter(goto.secondCall));
    });

    it('re-enables the cache if the reload fails when ignoreCache is set', async () => {
      const {page, context, response, args} = createHandlerMocks();
      page.pptrPage.url.returns('https://cold-load.example/');
      const error = new Error('Navigation failed');
      page.pptrPage.goto.onSecondCall().rejects(error);

      await assert.rejects(
        startTrace(args).handler(
          {params: {reload: true, autoStop: false, ignoreCache: true}, page},
          response,
          context,
        ),
        error,
      );

      sinon.assert.calledTwice(page.pptrPage.setCacheEnabled);
      sinon.assert.calledOnce(page.pptrPage.tracing.stop);
      sinon.assert.calledWithExactly(
        page.pptrPage.setCacheEnabled.secondCall,
        true,
      );
    });

    it('does not touch the cache when ignoreCache is not set', async () => {
      const {page, context, response, args} = createHandlerMocks();
      page.pptrPage.url.returns('https://cold-load.example/');

      await startTrace(args).handler(
        {params: {reload: true, autoStop: false}, page},
        response,
        context,
      );

      sinon.assert.calledOnceWithExactly(
        page.setIsRunningPerformanceTrace,
        true,
      );
      sinon.assert.notCalled(page.pptrPage.setCacheEnabled);
    });

    it('can autostop and store a recording', async () => {
      const rawData = loadTraceAsBuffer('basic-trace.json.gz');

      await withMcpContext(async (response, context, args) => {
        const selectedPage = context.getSelectedMcpPage().pptrPage;
        sinon
          .stub(selectedPage, 'url')
          .callsFake(() => 'https://trace.example/');
        sinon.stub(selectedPage, 'goto').callsFake(() => Promise.resolve(null));
        const startTracingStub = sinon.stub(selectedPage.tracing, 'start');
        const stopTracingStub = sinon
          .stub(selectedPage.tracing, 'stop')
          .callsFake(() => {
            return Promise.resolve(rawData);
          });

        const clock = sinon.useFakeTimers();
        const handlerPromise = startTrace(args).handler(
          {
            params: {reload: true, autoStop: true},
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );
        // In the handler we wait 5 seconds after the page load event (which is
        // what DevTools does), hence we now fake-progress time to allow
        // the handler to complete. We allow extra time because the Trace
        // Engine also uses some timers to yield updates and we need those to
        // execute.
        await clock.tickAsync(6_000);
        await handlerPromise;
        clock.restore();

        sinon.assert.calledOnce(startTracingStub);
        sinon.assert.calledOnce(stopTracingStub);
        assert.strictEqual(
          context.isRunningPerformanceTrace(),
          false,
          'Tracing was stopped',
        );
        assert.strictEqual(context.recordedTraces().length, 1);
        assert.ok(
          response.responseLines
            .join('\n')
            .match(/The performance trace has been stopped/),
        );
      });
    });

    it('errors if a recording is already active', async () => {
      const {page, context, response, args} = createHandlerMocks();
      context.isRunningPerformanceTrace.returns(true);

      await startTrace(args).handler(
        {params: {reload: true, autoStop: false}, page},
        response,
        context,
      );

      sinon.assert.calledOnceWithExactly(
        response.appendResponseLine,
        'Error: a performance trace is already running. Use performance_stop_trace to stop it. Only one trace can be running at any given time.',
      );
      sinon.assert.notCalled(page.setIsRunningPerformanceTrace);
      sinon.assert.notCalled(page.pptrPage.goto);
    });

    it('resets the running flag without stopping an unstarted trace', async () => {
      const {page, context, response, args} = createHandlerMocks();
      context.isRunningPerformanceTrace.returns(false);
      page.isRunningPerformanceTrace.returns(true);
      page.pptrPage.url.returns('https://trace.example/');
      page.pptrPage.goto.rejects(new Error('Navigation failed'));

      await assert.rejects(
        startTrace(args).handler(
          {
            params: {reload: true, autoStop: true},
            page,
          },
          response,
          context,
        ),
        /Navigation failed/,
      );

      sinon.assert.notCalled(page.pptrPage.tracing.start);
      sinon.assert.notCalled(page.pptrPage.tracing.stop);
      sinon.assert.calledTwice(page.setIsRunningPerformanceTrace);
      sinon.assert.calledWithExactly(
        page.setIsRunningPerformanceTrace.firstCall,
        true,
      );
      sinon.assert.calledWithExactly(
        page.setIsRunningPerformanceTrace.secondCall,
        false,
      );
    });

    it('supports filePath', async () => {
      const rawData = loadTraceAsBuffer('basic-trace.json.gz');
      // rawData is the decompressed buffer (based on loadTraceAsBuffer implementation).
      // We want to simulate saving it as a .gz file, so the tool should compress it.
      const expectedCompressedData = zlib.gzipSync(rawData);

      await withMcpContext(async (response, context, args) => {
        const filePath = 'test-trace.json.gz';
        const selectedPage = context.getSelectedMcpPage().pptrPage;
        sinon
          .stub(selectedPage, 'url')
          .callsFake(() => 'https://trace.example/');
        sinon.stub(selectedPage, 'goto').callsFake(() => Promise.resolve(null));
        sinon.stub(selectedPage.tracing, 'start');
        sinon.stub(selectedPage.tracing, 'stop').resolves(rawData);
        const saveFileStub = sinon
          .stub(context, 'saveFile')
          .resolves({filename: filePath});

        const clock = sinon.useFakeTimers({toFake: ['setTimeout']});
        const handlerPromise = startTrace(args).handler(
          {
            params: {reload: true, autoStop: true, filePath},
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );
        // In the handler we wait 5 seconds after the page load event (which is
        // what DevTools does). Fake only this wait, then return to real timers:
        // gzip runs on the thread pool, and trace parsing after it uses timers.
        await clock.tickAsync(5_000);
        clock.restore();
        await handlerPromise;

        assert.ok(
          response.responseLines.includes(
            `The raw trace data was saved to ${filePath}.`,
          ),
        );
        sinon.assert.calledOnce(saveFileStub);
        const [savedData, savedPath] = saveFileStub.firstCall.args;
        assert.strictEqual(savedPath, filePath);
        // Compare the saved data with expected compressed data
        // We can't compare buffers directly with strictEqual easily if they are different instances, but deepStrictEqual works for Buffers.
        assert.deepStrictEqual(savedData, expectedCompressedData);
      });
    });
  });

  describe('performance_analyze_insight', () => {
    async function parseTrace(fileName: string): Promise<TraceResult> {
      const rawData = loadTraceAsBuffer(fileName);
      const result = await parseRawTraceBuffer(rawData);
      if (!traceResultIsSuccess(result)) {
        assert.fail(`Unexpected trace parse error: ${result.error}`);
      }
      return result;
    }

    it('returns the information on the insight', async () => {
      const trace = await parseTrace('web-dev-with-commit.json.gz');
      const {page, context, response, args} = createHandlerMocks();
      context.recordedTraces.returns([trace]);

      await analyzeInsight(args).handler(
        {
          params: {
            insightSetId: 'NAVIGATION_0',
            insightName: 'LCPBreakdown',
          },
          page,
        },
        response,
        context,
      );

      sinon.assert.calledOnceWithExactly(
        response.attachTraceInsight,
        trace,
        'NAVIGATION_0',
        'LCPBreakdown',
      );
    });

    it('returns an error if no trace has been recorded', async () => {
      const {page, context, response, args} = createHandlerMocks();
      context.recordedTraces.returns([]);

      await analyzeInsight(args).handler(
        {
          params: {
            insightSetId: '8463DF94CD61B265B664E7F768183DE3',
            insightName: 'LCPBreakdown',
          },
          page,
        },
        response,
        context,
      );

      sinon.assert.calledOnceWithExactly(
        response.appendResponseLine,
        'No recorded traces found. Record a performance trace so you have Insights to analyze.',
      );
      sinon.assert.notCalled(response.attachTraceInsight);
    });
  });

  describe('performance_stop_trace', () => {
    it('returns an error message if no trace is running', async () => {
      const {page, context, response, args} = createHandlerMocks();
      context.isRunningPerformanceTrace.returns(false);

      await stopTrace(args).handler({params: {}, page}, response, context);

      sinon.assert.notCalled(page.setIsRunningPerformanceTrace);
      sinon.assert.notCalled(context.storeTraceRecording);
      sinon.assert.calledOnceWithExactly(
        response.appendResponseLine,
        'Error: no active performance trace recording to stop.',
      );
    });

    it('does not stop a trace recorded on a different page', async () => {
      const {page: activePage, context, response, args} = createHandlerMocks();
      const requestedPage = createMockMcpPage();
      activePage.isRunningPerformanceTrace.returns(true);
      requestedPage.isRunningPerformanceTrace.returns(false);
      context.isRunningPerformanceTrace.returns(true);
      const activePageStop = activePage.pptrPage.tracing.stop;
      const requestedPageStop = requestedPage.pptrPage.tracing.stop;

      await stopTrace(args).handler(
        {params: {}, page: requestedPage},
        response,
        context,
      );

      sinon.assert.notCalled(activePageStop);
      sinon.assert.notCalled(requestedPageStop);
      sinon.assert.calledOnceWithExactly(
        response.appendResponseLine,
        'Error: no active performance trace recording to stop.',
      );
    });

    it('will stop the trace and return trace info when a trace is running', async () => {
      const rawData = loadTraceAsBuffer('basic-trace.json.gz');
      await withMcpContext(async (response, context, args) => {
        const selectedMcpPageForTrace = context.getSelectedMcpPage();
        assert.ok(
          tryClaimPerformanceTrace(
            selectedMcpPageForTrace.pptrPage,
            selectedMcpPageForTrace,
          ),
        );
        selectedMcpPageForTrace.setIsRunningPerformanceTrace(true);
        const selectedPage = context.getSelectedMcpPage().pptrPage;
        const stopTracingStub = sinon
          .stub(selectedPage.tracing, 'stop')
          .callsFake(async () => {
            return rawData;
          });
        await stopTrace(args).handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );
        assert.ok(
          response.responseLines.includes(
            'The performance trace has been stopped.',
          ),
        );
        assert.strictEqual(context.recordedTraces().length, 1);
        sinon.assert.calledOnce(stopTracingStub);
      });
    });

    it('throws an error if parsing the trace buffer fails', async () => {
      await withMcpContext(async (response, context, args) => {
        const selectedMcpPageForTrace = context.getSelectedMcpPage();
        assert.ok(
          tryClaimPerformanceTrace(
            selectedMcpPageForTrace.pptrPage,
            selectedMcpPageForTrace,
          ),
        );
        selectedMcpPageForTrace.setIsRunningPerformanceTrace(true);
        const selectedPage = context.getSelectedMcpPage().pptrPage;
        sinon
          .stub(selectedPage.tracing, 'stop')
          .returns(Promise.resolve(undefined));

        await assert.rejects(
          stopTrace(args).handler(
            {params: {}, page: context.getSelectedMcpPage()},
            response,
            context,
          ),
          /There was an unexpected error parsing the trace/,
        );
      });
    });

    it('supports filePath', async () => {
      const rawData = loadTraceAsBuffer('basic-trace.json.gz');
      await withMcpContext(async (response, context, args) => {
        const filePath = 'test-trace.json';
        const selectedMcpPageForTrace = context.getSelectedMcpPage();
        assert.ok(
          tryClaimPerformanceTrace(
            selectedMcpPageForTrace.pptrPage,
            selectedMcpPageForTrace,
          ),
        );
        selectedMcpPageForTrace.setIsRunningPerformanceTrace(true);
        const selectedPage = context.getSelectedMcpPage().pptrPage;
        const stopTracingStub = sinon
          .stub(selectedPage.tracing, 'stop')
          .resolves(rawData);
        const saveFileStub = sinon
          .stub(context, 'saveFile')
          .resolves({filename: filePath});

        await stopTrace(args).handler(
          {params: {filePath}, page: context.getSelectedMcpPage()},
          response,
          context,
        );

        sinon.assert.calledOnce(stopTracingStub);
        sinon.assert.calledOnce(saveFileStub);
        sinon.assert.calledWith(saveFileStub, rawData, filePath);
        assert.ok(
          response.responseLines.includes(
            `The raw trace data was saved to ${filePath}.`,
          ),
        );
      });
    });

    it('does not fetch CrUX data if performanceCrux is false', async () => {
      const rawData = loadTraceAsBuffer('basic-trace.json.gz');
      await withMcpContext(
        async (response, context, args) => {
          const selectedMcpPageForTrace = context.getSelectedMcpPage();
          assert.ok(
            tryClaimPerformanceTrace(
              selectedMcpPageForTrace.pptrPage,
              selectedMcpPageForTrace,
            ),
          );
          selectedMcpPageForTrace.setIsRunningPerformanceTrace(true);
          const selectedPage = context.getSelectedMcpPage().pptrPage;
          sinon.stub(selectedPage.tracing, 'stop').resolves(rawData);

          await stopTrace(args).handler(
            {params: {}, page: context.getSelectedMcpPage()},
            response,
            context,
          );

          const cruxEndpoint =
            'https://chromeuxreport.googleapis.com/v1/records:queryRecord';
          const cruxCall = (globalThis.fetch as sinon.SinonStub)
            .getCalls()
            .find(call => call.args[0].toString().startsWith(cruxEndpoint));
          assert.strictEqual(
            cruxCall,
            undefined,
            'CrUX fetch should not have been called',
          );
        },
        {performanceCrux: false},
      );
    });

    it('fetches CrUX data for desktop and includes it in the summary', async () => {
      const rawData = loadTraceAsBuffer('web-dev-with-commit.json.gz');
      await withMcpContext(async (response, context, args) => {
        const selectedMcpPageForTrace = context.getSelectedMcpPage();
        assert.ok(
          tryClaimPerformanceTrace(
            selectedMcpPageForTrace.pptrPage,
            selectedMcpPageForTrace,
          ),
        );
        selectedMcpPageForTrace.setIsRunningPerformanceTrace(true);
        const selectedPage = context.getSelectedMcpPage().pptrPage;
        sinon.stub(selectedPage.tracing, 'stop').resolves(rawData);

        const fetchStub = globalThis.fetch as sinon.SinonStub;
        fetchStub.resetHistory();
        fetchStub.callsFake(async (url, options) => {
          const body = options?.body ? JSON.parse(options.body as string) : {};
          const requestedUrl = body.url || body.origin || 'https://web.dev/';
          const lcp = body.formFactor === 'DESKTOP' ? 1000 : 2595;
          return new Response(
            JSON.stringify(cruxResponseFixture(requestedUrl, lcp)),
            {
              status: 200,
              headers: {'Content-Type': 'application/json'},
            },
          );
        });

        await stopTrace(args).handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );

        const result = await response.handle(context);
        const fullOutput = result.content
          .map(c => (c.type === 'text' ? c.text : ''))
          .join('\n');

        assert.ok(fetchStub.called, 'CrUX fetch should have been called');
        assert.ok(
          fullOutput.includes('Metrics (field / real users)'),
          'Summary should include field data',
        );
        assert.ok(
          fullOutput.includes('LCP: 1000 ms'),
          'Summary should include desktop LCP value',
        );
      });
    });

    it('fetches CrUX data for mobile and includes it in the summary', async () => {
      const rawData = loadTraceAsBuffer('web-dev-with-commit.json.gz');
      // Use a unique URL to avoid cache issues
      const jsonString = new TextDecoder().decode(rawData);
      const modifiedJsonString = jsonString.replaceAll(
        'https://web.dev/',
        'https://mobile.web.dev/',
      );
      const modifiedData = new TextEncoder().encode(modifiedJsonString);

      await withMcpContext(async (response, context, args) => {
        const selectedMcpPageForTrace = context.getSelectedMcpPage();
        assert.ok(
          tryClaimPerformanceTrace(
            selectedMcpPageForTrace.pptrPage,
            selectedMcpPageForTrace,
          ),
        );
        selectedMcpPageForTrace.setIsRunningPerformanceTrace(true);
        const selectedPage = context.getSelectedMcpPage().pptrPage;
        sinon.stub(selectedPage.tracing, 'stop').resolves(modifiedData);

        // Emulate mobile
        await context.getSelectedMcpPage().emulate({
          viewport: {
            width: 375,
            height: 667,
            isMobile: true,
            hasTouch: true,
            deviceScaleFactor: 2,
          },
        });

        const fetchStub = globalThis.fetch as sinon.SinonStub;
        fetchStub.resetHistory();
        fetchStub.callsFake(async (url, options) => {
          const body = options?.body ? JSON.parse(options.body as string) : {};
          const requestedUrl = body.url || body.origin || 'https://web.dev/';
          const lcp = body.formFactor === 'PHONE' ? 2000 : 2595;
          return new Response(
            JSON.stringify(cruxResponseFixture(requestedUrl, lcp)),
            {
              status: 200,
              headers: {'Content-Type': 'application/json'},
            },
          );
        });

        await stopTrace(args).handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );

        const result = await response.handle(context);
        const fullOutput = result.content
          .map(c => (c.type === 'text' ? c.text : ''))
          .join('\n');

        assert.ok(fetchStub.called, 'CrUX fetch should have been called');
        assert.ok(
          fullOutput.includes('Metrics (field / real users)'),
          'Summary should include field data',
        );
        assert.ok(
          fullOutput.includes('LCP: 2000 ms'),
          'Summary should include mobile LCP value',
        );
      });
    });
  });
});

function cruxResponseFixture(url = 'https://web.dev/', lcp = 2595) {
  // Ideally we could use `mockResponse` from 'chrome-devtools-frontend/front_end/models/crux-manager/CrUXManager.test.ts'
  // But test files are not published in the cdtf npm package.
  return {
    record: {
      key: {
        url,
      },
      metrics: {
        form_factors: {
          fractions: {desktop: 0.5056, phone: 0.4796, tablet: 0.0148},
        },
        largest_contentful_paint: {
          histogram: [
            {start: 0, end: 2500, density: 0.7309},
            {start: 2500, end: 4000, density: 0.163},
            {start: 4000, density: 0.1061},
          ],
          percentiles: {p75: lcp},
        },
        largest_contentful_paint_image_element_render_delay: {
          percentiles: {p75: 786},
        },
        largest_contentful_paint_image_resource_load_delay: {
          percentiles: {p75: 86},
        },
        largest_contentful_paint_image_time_to_first_byte: {
          percentiles: {p75: 1273},
        },
        cumulative_layout_shift: {
          histogram: [
            {start: '0.00', end: '0.10', density: 0.8665},
            {start: '0.10', end: '0.25', density: 0.0716},
            {start: '0.25', density: 0.0619},
          ],
          percentiles: {p75: '0.06'},
        },
        interaction_to_next_paint: {
          histogram: [
            {start: 0, end: 200, density: 0.8414},
            {start: 200, end: 500, density: 0.1081},
            {start: 500, density: 0.0505},
          ],
          percentiles: {p75: 140},
        },
        largest_contentful_paint_image_resource_load_duration: {
          percentiles: {p75: 451},
        },
        round_trip_time: {
          histogram: [
            {start: 0, end: 75, density: 0.3663},
            {start: 75, end: 275, density: 0.5089},
            {start: 275, density: 0.1248},
          ],
          percentiles: {p75: 178},
        },
        first_contentful_paint: {
          histogram: [
            {start: 0, end: 1800, density: 0.5899},
            {start: 1800, end: 3000, density: 0.2439},
            {start: 3000, density: 0.1662},
          ],
          percentiles: {p75: 2425},
        },
      },
      collectionPeriod: {
        firstDate: {year: 2025, month: 12, day: 8},
        lastDate: {year: 2026, month: 1, day: 4},
      },
    },
  };
}
