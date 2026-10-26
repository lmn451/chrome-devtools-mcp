/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

interface PerformanceTraceRecord {
  owner: object;
  setupPromise: Promise<void>;
  resolveSetup: () => void;
  setupComplete: boolean;
  stopPromise?: Promise<unknown>;
}

const traceOwners = new WeakMap<object, PerformanceTraceRecord>();
const pageOperationTails = new WeakMap<object, Promise<void>>();
const closingPages = new WeakSet<object>();
let activeTraceCount = 0;
let globalOperationTail: Promise<void> = Promise.resolve();
let globalOperationCount = 0;

export const PERFORMANCE_TRACE_OWNED_BY_ANOTHER_SESSION_MESSAGE =
  'Error: this page is being traced by another MCP session. Stop that trace before modifying the page.';
export const PERFORMANCE_TRACE_PAGE_CLOSING_MESSAGE =
  'Error: this page is closing. Try again with an open page.';
export const PERFORMANCE_TRACE_CLOSE_BLOCKED_MESSAGE =
  'Error: this page is being traced by another MCP session. Stop that trace before closing it.';
export const PERFORMANCE_TRACE_GLOBAL_LOCK_BUSY_MESSAGE =
  'Error: a service worker evaluation is in progress. Try starting the performance trace again after it completes.';

/** Serializes service-worker evaluation against trace setup across all pages. */
export async function withPerformanceTraceGlobalLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const previous = globalOperationTail;
  let release!: () => void;
  const current = new Promise<void>(resolve => {
    release = resolve;
  });
  globalOperationTail = current;
  globalOperationCount++;

  try {
    await previous;
    return await operation();
  } finally {
    globalOperationCount--;
    release();
    if (globalOperationTail === current) {
      globalOperationTail = Promise.resolve();
    }
  }
}

/**
 * Runs a synchronous operation only when no global operation is active or queued.
 * The callback must not return a promise.
 */
export function tryWithPerformanceTraceGlobalLock<T>(
  operation: () => T,
): {acquired: true; value: T} | {acquired: false} {
  if (globalOperationCount > 0) {
    return {acquired: false};
  }

  let release!: () => void;
  const current = new Promise<void>(resolve => {
    release = resolve;
  });
  globalOperationTail = current;
  globalOperationCount++;

  try {
    return {acquired: true, value: operation()};
  } finally {
    globalOperationCount--;
    release();
    if (globalOperationTail === current) {
      globalOperationTail = Promise.resolve();
    }
  }
}

/** Returns whether a performance trace is active or starting anywhere. */
export function hasActivePerformanceTrace(): boolean {
  return activeTraceCount > 0;
}

/** Returns whether a close operation has reserved this shared Puppeteer Page. */
export function isPageClosing(page: object): boolean {
  return closingPages.has(page);
}

/** Reserves a page for closing; call while holding its page-operation lock. */
export function tryBeginPageClose(page: object, owner: object): boolean {
  if (
    closingPages.has(page) ||
    isPerformanceTraceOwnedByAnotherSession(page, owner)
  ) {
    return false;
  }
  closingPages.add(page);
  return true;
}

/** Releases a page-close reservation after the close attempt settles. */
export function finishPageClose(page: object): void {
  closingPages.delete(page);
}

/** Returns why a mutating page operation cannot run, if it is blocked. */
export function getPageMutationBlockMessage(
  page: object,
  owner: object & {isClosed(): boolean},
): string | undefined {
  if (closingPages.has(page) || owner.isClosed()) {
    return PERFORMANCE_TRACE_PAGE_CLOSING_MESSAGE;
  }
  if (isPerformanceTraceOwnedByAnotherSession(page, owner)) {
    return PERFORMANCE_TRACE_OWNED_BY_ANOTHER_SESSION_MESSAGE;
  }
  return undefined;
}

/** Serializes page mutations and trace setup across sessions sharing a Page. */
export async function withPerformanceTracePageLock<T>(
  page: object,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = pageOperationTails.get(page) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => {
    release = resolve;
  });
  pageOperationTails.set(page, current);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (pageOperationTails.get(page) === current) {
      pageOperationTails.delete(page);
    }
  }
}

function createTraceRecord(
  owner: object,
  setupPending: boolean,
): PerformanceTraceRecord {
  let resolveSetup!: () => void;
  const record: PerformanceTraceRecord = {
    owner,
    setupPromise: new Promise(resolve => {
      resolveSetup = resolve;
    }),
    resolveSetup: () => {
      if (!record.setupComplete) {
        record.setupComplete = true;
        resolveSetup();
      }
    },
    setupComplete: false,
  };
  if (!setupPending) {
    record.resolveSetup();
  }
  return record;
}

/** Claims the Puppeteer page for one performance trace owner. */
export function tryClaimPerformanceTrace(
  page: object,
  owner: object,
  options: {setupPending?: boolean} = {},
): boolean {
  if (closingPages.has(page)) {
    return false;
  }
  const currentRecord = traceOwners.get(page);
  if (currentRecord !== undefined) {
    return currentRecord.owner === owner;
  }
  traceOwners.set(
    page,
    createTraceRecord(owner, options.setupPending ?? false),
  );
  activeTraceCount++;
  return true;
}

/** Returns whether this owner still controls the page's performance trace. */
export function ownsPerformanceTrace(page: object, owner: object): boolean {
  return traceOwners.get(page)?.owner === owner;
}

/** Returns whether a different session currently owns this page's trace. */
export function isPerformanceTraceOwnedByAnotherSession(
  page: object,
  owner: object,
): boolean {
  const currentOwner = traceOwners.get(page)?.owner;
  return currentOwner !== undefined && currentOwner !== owner;
}

/** Marks a claimed trace's startup navigation and tracing.start() as complete. */
export function markPerformanceTraceSetupComplete(
  page: object,
  owner: object,
): void {
  const record = traceOwners.get(page);
  if (record?.owner === owner) {
    record.resolveSetup();
  }
}

/** Stops an owned trace once, sharing the stop operation across cleanup paths. */
export async function stopOwnedPerformanceTrace<T>(
  page: object,
  owner: object,
  stop: () => Promise<T>,
): Promise<T> {
  const record = traceOwners.get(page);
  if (record?.owner !== owner) {
    throw new Error('This session does not own the performance trace.');
  }

  await record.setupPromise;
  if (traceOwners.get(page) !== record) {
    throw new Error(
      'The performance trace is no longer owned by this session.',
    );
  }

  record.stopPromise ??= Promise.resolve().then(stop);
  return (await record.stopPromise) as T;
}

/** Releases the page only when the caller is still its trace owner. */
export function releasePerformanceTrace(page: object, owner: object): void {
  const record = traceOwners.get(page);
  if (record?.owner === owner) {
    record.resolveSetup();
    traceOwners.delete(page);
    activeTraceCount--;
  }
}

/** Forgets trace ownership after the Puppeteer page has been destroyed. */
export function forgetPerformanceTrace(page: object): void {
  const record = traceOwners.get(page);
  record?.resolveSetup();
  if (record !== undefined) {
    traceOwners.delete(page);
    activeTraceCount--;
  }
}
