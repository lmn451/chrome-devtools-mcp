/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import zlib from 'node:zlib';

import {zod, DevTools} from '../third_party/index.js';
import {
  parseRawTraceBuffer,
  traceResultIsSuccess,
  type InsightName,
  type TraceResult,
} from '../processors/PerformanceTrace.js';
import {logger} from '../utils/logger.js';
import {
  markPerformanceTraceSetupComplete,
  ownsPerformanceTrace,
  PERFORMANCE_TRACE_GLOBAL_LOCK_BUSY_MESSAGE,
  PERFORMANCE_TRACE_PAGE_CLOSING_MESSAGE,
  tryWithPerformanceTraceGlobalLock,
  withPerformanceTracePageLock,
  releasePerformanceTrace,
  stopOwnedPerformanceTrace,
  tryClaimPerformanceTrace,
  isPageClosing,
} from '../utils/PerformanceTraceRegistry.js';

import {ToolCategory} from './categories.js';
import {
  definePageTool,
  type Context,
  type Response,
  type ContextPage,
  type PageToolFactory,
} from './ToolDefinition.js';

const performanceToolsDisabledMessage =
  'Error: performance tools are disabled.';

const performanceTraceAlreadyRunningMessage =
  'Error: a performance trace is already running. Use performance_stop_trace to stop it. Only one trace can be running at any given time.';

const pageClosedDuringTraceSetup = new Error('Page closed during trace setup');
const performanceToolsDisabledDuringTraceSetup = new Error(
  'Performance tools disabled during trace setup',
);

const filePathSchema = zod
  .string()
  .optional()
  .describe(
    'The absolute file path, or a file path relative to the current working directory, to save the raw trace data. For example, trace.json.gz (compressed) or trace.json (uncompressed).',
  );

export const startTrace: PageToolFactory = definePageTool(() => ({
  name: 'performance_start_trace',
  description: `Start a performance trace on the target webpage. Use to find frontend performance issues, Core Web Vitals (LCP, INP, CLS), and improve page load speed.`,
  annotations: {
    category: ToolCategory.PERFORMANCE,
    readOnlyHint: false,
  },
  schema: {
    reload: zod
      .boolean()
      .default(true)
      .describe(
        'Determines if, once tracing has started, the target page should be automatically reloaded. Navigate the page to the right URL using the navigate_page tool BEFORE starting the trace if reload or autoStop is set to true.',
      ),
    autoStop: zod
      .boolean()
      .default(true)
      .describe(
        'Determines if the trace recording should be automatically stopped.',
      ),
    ignoreCache: zod
      .boolean()
      .optional()
      .describe(
        'Whether to bypass the HTTP cache when reloading the page, to measure a cold page load. Only applies if reload is true.',
      ),
    filePath: filePathSchema,
  },
  blockedByDialog: true,
  concurrency: 'exclusive',
  verifyFilesSchema: {
    filePath: true,
  },
  handler: async (request, response, context) => {
    const page = request.page;
    const pptrPage = page.pptrPage;
    const started = await withPerformanceTracePageLock(pptrPage, async () => {
      if (page.isClosed() || isPageClosing(pptrPage)) {
        response.appendResponseLine(PERFORMANCE_TRACE_PAGE_CLOSING_MESSAGE);
        return false;
      }
      if (!context.isPerformanceTraceEnabled()) {
        response.appendResponseLine(performanceToolsDisabledMessage);
        return false;
      }
      if (context.isRunningPerformanceTrace()) {
        response.appendResponseLine(performanceTraceAlreadyRunningMessage);
        return false;
      }

      const traceClaim = tryWithPerformanceTraceGlobalLock(() =>
        tryClaimPerformanceTrace(pptrPage, page, {setupPending: true}),
      );
      if (!traceClaim.acquired) {
        response.appendResponseLine(PERFORMANCE_TRACE_GLOBAL_LOCK_BUSY_MESSAGE);
        return false;
      }
      if (!traceClaim.value) {
        response.appendResponseLine(performanceTraceAlreadyRunningMessage);
        return false;
      }

      let traceStartedByThisCall = false;
      let cacheDisabled = false;
      let blankPageNavigated = false;
      const pageUrlForTracing = pptrPage.url();
      const ensureTraceSetupCanContinue = (): void => {
        if (page.isClosed()) {
          throw pageClosedDuringTraceSetup;
        }
        if (!context.isPerformanceTraceEnabled()) {
          throw performanceToolsDisabledDuringTraceSetup;
        }
      };
      try {
        page.setIsRunningPerformanceTrace(true);
        if (request.params.reload) {
          // Before starting the recording, navigate to about:blank to clear out any state.
          // We use `load` because `networkidle0` is known to be flaky for about:blank in Puppeteer.
          ensureTraceSetupCanContinue();
          await pptrPage.goto('about:blank', {
            waitUntil: 'load',
          });
          blankPageNavigated = true;
          ensureTraceSetupCanContinue();
        }

        const categories = [
          '-*',
          ...DevTools.TracingDefaultCategories,
          // These categories are optional in DevTools, but enabled by default in the DevTools UI, so we enable them here too.
          ...DevTools.TracingOptionalCategories.JsSampling,
          ...DevTools.TracingOptionalCategories.Screenshot,
        ];
        ensureTraceSetupCanContinue();
        await pptrPage.tracing.start({
          categories,
          bufferSize: 1200 * 1000,
        });
        traceStartedByThisCall = true;
        ensureTraceSetupCanContinue();

        if (request.params.reload) {
          const ignoreCache = request.params.ignoreCache ?? false;
          try {
            if (ignoreCache) {
              // Disable the HTTP cache so that the main document and all
              // subresources are fetched from the network, like a hard reload.
              ensureTraceSetupCanContinue();
              await pptrPage.setCacheEnabled(false);
              cacheDisabled = true;
            }
            ensureTraceSetupCanContinue();
            await pptrPage.goto(pageUrlForTracing, {
              waitUntil: ['load'],
            });
            ensureTraceSetupCanContinue();
          } finally {
            if (cacheDisabled) {
              await pptrPage.setCacheEnabled(true);
              cacheDisabled = false;
            }
          }
        }

        ensureTraceSetupCanContinue();
        markPerformanceTraceSetupComplete(pptrPage, page);
        return true;
      } catch (error) {
        markPerformanceTraceSetupComplete(pptrPage, page);
        // Only stop a trace that this call successfully started and still owns.
        // A failed start on a shared Puppeteer Page must not stop another session's trace.
        if (traceStartedByThisCall && ownsPerformanceTrace(pptrPage, page)) {
          try {
            await stopOwnedPerformanceTrace(pptrPage, page, () =>
              pptrPage.tracing.stop(),
            );
          } catch {
            // Tracing may already have stopped; ignore cleanup errors.
          }
        }
        try {
          page.setIsRunningPerformanceTrace(false);
        } finally {
          try {
            if (
              error === performanceToolsDisabledDuringTraceSetup &&
              blankPageNavigated &&
              !page.isClosed() &&
              pptrPage.url() !== pageUrlForTracing
            ) {
              try {
                await pptrPage.goto(pageUrlForTracing, {
                  waitUntil: ['load'],
                });
              } catch (restoreError) {
                logger?.(
                  'Failed to restore page URL after performance trace setup was canceled: %s',
                  restoreError,
                );
              }
            }
          } finally {
            releasePerformanceTrace(pptrPage, page);
          }
        }
        if (error === pageClosedDuringTraceSetup) {
          response.appendResponseLine(PERFORMANCE_TRACE_PAGE_CLOSING_MESSAGE);
          return false;
        }
        if (error === performanceToolsDisabledDuringTraceSetup) {
          response.appendResponseLine(performanceToolsDisabledMessage);
          return false;
        }
        throw error;
      } finally {
        markPerformanceTraceSetupComplete(pptrPage, page);
      }
    });

    if (!started || page.isClosed() || !ownsPerformanceTrace(pptrPage, page)) {
      return;
    }

    if (request.params.autoStop) {
      await new Promise(resolve => setTimeout(resolve, 5_000));
      if (page.isClosed() || !ownsPerformanceTrace(pptrPage, page)) {
        return;
      }
      await withPerformanceTracePageLock(pptrPage, async () => {
        if (!page.isClosed() && ownsPerformanceTrace(pptrPage, page)) {
          await stopTracingAndAppendOutput(
            page,
            response,
            context,
            request.params.filePath,
          );
        }
      });
    } else {
      response.appendResponseLine(
        `The performance trace is being recorded. Use performance_stop_trace to stop it.`,
      );
    }
  },
}));

export const stopTrace: PageToolFactory = definePageTool(() => ({
  name: 'performance_stop_trace',
  description:
    'Stop the active performance trace recording on the target webpage.',
  annotations: {
    category: ToolCategory.PERFORMANCE,
    readOnlyHint: false,
  },
  schema: {
    filePath: filePathSchema,
  },
  blockedByDialog: true,
  concurrency: 'exclusive',
  verifyFilesSchema: {
    filePath: true,
  },
  handler: async (request, response, context) => {
    const page = request.page;
    await withPerformanceTracePageLock(page.pptrPage, async () => {
      if (!page.isRunningPerformanceTrace()) {
        response.appendResponseLine(
          'Error: no active performance trace recording to stop.',
        );
        return;
      }
      await stopTracingAndAppendOutput(
        page,
        response,
        context,
        request.params.filePath,
      );
    });
  },
}));

export const analyzeInsight: PageToolFactory = definePageTool(() => ({
  name: 'performance_analyze_insight',
  description:
    'Provides more detailed information on a specific Performance Insight of an insight set that was highlighted in the results of a trace recording.',
  annotations: {
    category: ToolCategory.PERFORMANCE,
    readOnlyHint: true,
  },
  schema: {
    insightSetId: zod
      .string()
      .describe(
        'The id for the specific insight set. Only use the ids given in the "Available insight sets" list.',
      ),
    insightName: zod
      .string()
      .describe(
        'The name of the Insight you want more information on. For example: "DocumentLatency" or "LCPBreakdown"',
      ),
  },
  blockedByDialog: false,
  concurrency: 'exclusive',
  verifyFilesSchema: {},
  handler: async (request, response, context) => {
    const lastRecording = context.recordedTraces().at(-1);
    if (!lastRecording) {
      response.appendResponseLine(
        'No recorded traces found. Record a performance trace so you have Insights to analyze.',
      );
      return;
    }

    response.attachTraceInsight(
      lastRecording,
      request.params.insightSetId,
      request.params.insightName as InsightName,
    );
  },
}));

async function stopTracingAndAppendOutput(
  page: ContextPage,
  response: Response,
  context: Context,
  filePath?: string,
): Promise<void> {
  try {
    const pptrPage = page.pptrPage;
    const traceEventsBuffer = await stopOwnedPerformanceTrace(
      pptrPage,
      page,
      () => pptrPage.tracing.stop(),
    );
    if (filePath && traceEventsBuffer) {
      let dataToWrite: Uint8Array = traceEventsBuffer;
      if (filePath.endsWith('.gz')) {
        dataToWrite = await new Promise((resolve, reject) => {
          zlib.gzip(traceEventsBuffer, (error, result) => {
            if (error) {
              reject(error);
            } else {
              resolve(result);
            }
          });
        });
      }
      const file = await context.saveFile(
        dataToWrite,
        filePath,
        filePath.endsWith('.gz') ? '.gz' : '.json',
      );
      response.appendResponseLine(
        `The raw trace data was saved to ${file.filename}.`,
      );
    }
    const result = await parseRawTraceBuffer(traceEventsBuffer, {
      cpuThrottling: page.cpuThrottlingRate,
      networkThrottling: page.networkConditions ?? undefined,
    });
    response.appendResponseLine('The performance trace has been stopped.');
    if (traceResultIsSuccess(result)) {
      if (context.isCruxEnabled()) {
        await populateCruxData(result);
      }
      context.storeTraceRecording(result);
      response.attachTraceSummary(result);
    } else {
      throw new Error(
        `There was an unexpected error parsing the trace: ${result.error}`,
      );
    }
  } finally {
    try {
      page.setIsRunningPerformanceTrace(false);
    } finally {
      releasePerformanceTrace(page.pptrPage, page);
    }
  }
}

/** We tell CrUXManager to fetch data so it's available when DevTools.PerformanceTraceFormatter is invoked */
async function populateCruxData(result: TraceResult): Promise<void> {
  logger?.('populateCruxData called');
  const cruxManager = DevTools.CrUXManager.CrUXManager.instance();
  // go/jtfbx. Yes, we're aware this API key is public. ;)
  cruxManager.setEndpointForTesting(
    'https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=AIzaSyBn5gimNjhiEyA_euicSKko6IlD3HdgUfk',
  );
  const cruxSetting =
    DevTools.Common.Settings.Settings.instance().createSetting('field-data', {
      enabled: true,
    });
  cruxSetting.set({enabled: true});

  // Gather URLs to fetch CrUX data for
  const urls = [...(result.parsedTrace.insights?.values() ?? [])].map(c =>
    c.url.toString(),
  );
  urls.push(result.parsedTrace.data.Meta.mainFrameURL);
  const urlSet = new Set(urls);

  if (urlSet.size === 0) {
    logger?.('No URLs found for CrUX data');
    return;
  }

  logger?.(
    `Fetching CrUX data for ${urlSet.size} URLs: ${Array.from(urlSet).join(', ')}`,
  );
  const cruxData = await Promise.all(
    Array.from(urlSet).map(async url => {
      const data = await cruxManager.getFieldDataForPage(url);
      logger?.(`CrUX data for ${url}: ${data ? 'found' : 'not found'}`);
      return data;
    }),
  );

  result.parsedTrace.metadata.cruxFieldData = cruxData;
}
