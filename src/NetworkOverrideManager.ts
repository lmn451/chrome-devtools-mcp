/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';

import {URLPattern} from './third_party/cli.js';
import {
  type HTTPRequest,
  Mutex,
  type Page,
  type ResourceType,
} from './third_party/index.js';
import {logger} from './utils/logger.js';

interface BaseNetworkOverride {
  urlPattern: string;
  resourceType?: ResourceType;
}

export interface NetworkMockFilter {
  urlPattern?: string;
  resourceType?: ResourceType;
}

export interface FileNetworkOverrideInput extends NetworkMockFilter {
  kind: 'file';
  responseFilePath: string;
  contentType?: string;
  loadResponseFile: () => Promise<Uint8Array<ArrayBufferLike>>;
}

export type NetworkMockInput = FileNetworkOverrideInput;

interface NetworkOverrideBase extends BaseNetworkOverride {
  id: number;
  diagnostics: {
    hits: number;
    errors: number;
    navigations: number;
    lastError?: string;
  };
}

export interface FileNetworkOverride extends NetworkOverrideBase {
  kind: 'file';
  responseFilePath: string;
  contentType: string;
}

export type NetworkOverride = FileNetworkOverride;

interface StoredNetworkOverrideBase extends NetworkOverrideBase {
  matcher: URLPattern;
  owner: object;
}

interface StoredFileNetworkOverride extends StoredNetworkOverrideBase {
  kind: 'file';
  responseFilePath: string;
  contentType: string;
  loadResponseFile: () => Promise<Uint8Array<ArrayBufferLike>>;
}

type StoredNetworkOverride = StoredFileNetworkOverride;

const DEFAULT_URL_PATTERN = '*://*:*/*';
const DEFAULT_NETWORK_MOCK_OWNER = {};

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.xml': 'application/xml; charset=utf-8',
};

function inferContentType(filePath: string): string {
  return (
    CONTENT_TYPES[path.extname(filePath).toLowerCase()] ??
    'application/octet-stream'
  );
}

function toNetworkOverride(override: StoredNetworkOverride): NetworkOverride {
  const base = {
    id: override.id,
    urlPattern: override.urlPattern,
    resourceType: override.resourceType,
    diagnostics: {...override.diagnostics},
  };
  return {
    ...base,
    kind: override.kind,
    responseFilePath: override.responseFilePath,
    contentType: override.contentType,
  };
}

function matchesFilter(
  override: BaseNetworkOverride,
  filter: NetworkMockFilter,
): boolean {
  return (
    (filter.urlPattern === undefined ||
      override.urlPattern === filter.urlPattern) &&
    (filter.resourceType === undefined ||
      override.resourceType === filter.resourceType)
  );
}

interface SharedNetworkOverrideManagerEntry {
  manager: NetworkOverrideManager;
  owners: Set<object>;
  disposalPromise?: Promise<void>;
}

const managersByPage = new WeakMap<Page, SharedNetworkOverrideManagerEntry>();

export class NetworkOverrideManager {
  #page: Page;
  #overrides = new Map<number, StoredNetworkOverride>();
  #nextId = 1;
  #active = false;
  #cacheDisabled = false;
  #disposed = false;
  #pageClosed = false;
  #disposePromise?: Promise<void>;
  #lifecycleMutex = new Mutex();

  #pageCloseHandler = (): void => {
    this.#pageClosed = true;
    void this.dispose().catch(error => {
      logger?.('Failed to dispose network mocks after page close', error);
    });
  };

  #requestHandler = (request: HTTPRequest): Promise<void> => {
    return this.#handleRequest(request);
  };

  constructor(page: Page) {
    this.#page = page;
  }

  async mock(
    input: NetworkMockInput,
    owner: object = DEFAULT_NETWORK_MOCK_OWNER,
  ): Promise<NetworkOverride> {
    return await this.#runLifecycleOperation(() => this.#mock(input, owner));
  }

  async #mock(
    input: NetworkMockInput,
    owner: object,
  ): Promise<NetworkOverride> {
    if (this.#disposed) {
      throw new Error('Cannot update mocks after the page was disposed.');
    }
    const urlPattern = input.urlPattern ?? DEFAULT_URL_PATTERN;
    const existing = [...this.#overrides.values()].find(
      override =>
        override.owner === owner &&
        override.urlPattern === urlPattern &&
        override.resourceType === input.resourceType,
    );
    const override = await this.#createOverride(input, owner, existing);
    if (this.#disposed) {
      throw new Error('Cannot update mocks after the page was disposed.');
    }
    const previous = this.#overrides;
    const overrides = new Map(previous);
    overrides.delete(override.id);
    overrides.set(override.id, override);
    this.#overrides = overrides;
    try {
      await this.#activate();
    } catch (error) {
      this.#overrides = this.#disposed ? new Map() : previous;
      throw error;
    }
    if (!existing) {
      this.#nextId++;
    }
    return toNetworkOverride(override);
  }

  async #createOverride(
    input: NetworkMockInput,
    owner: object,
    existing?: StoredNetworkOverride,
  ): Promise<StoredNetworkOverride> {
    const urlPattern = input.urlPattern ?? DEFAULT_URL_PATTERN;
    const base = {
      id: existing?.id ?? this.#nextId,
      urlPattern,
      resourceType: input.resourceType,
      matcher: new URLPattern(urlPattern),
      owner,
      diagnostics: {hits: 0, errors: 0, navigations: 0},
    };

    await input.loadResponseFile();
    return {
      ...base,
      kind: input.kind,
      responseFilePath: input.responseFilePath,
      contentType:
        input.contentType ?? inferContentType(input.responseFilePath),
      loadResponseFile: input.loadResponseFile,
    };
  }

  list(filter: NetworkMockFilter = {}, owner?: object): NetworkOverride[] {
    const overrides: NetworkOverride[] = [];
    for (const override of this.#overrides.values()) {
      if (
        (owner === undefined || override.owner === owner) &&
        matchesFilter(override, filter)
      ) {
        overrides.push(toNetworkOverride(override));
      }
    }
    return overrides;
  }

  async remove(filter: NetworkMockFilter, owner?: object): Promise<number> {
    return await this.#runLifecycleOperation(async () => {
      if (this.#disposed) {
        throw new Error('Cannot remove mocks after the page was disposed.');
      }
      const overrides = new Map(this.#overrides);
      for (const [id, override] of overrides) {
        if (
          (owner === undefined || override.owner === owner) &&
          matchesFilter(override, filter)
        ) {
          overrides.delete(id);
        }
      }
      const removed = this.#overrides.size - overrides.size;
      if (removed === 0) {
        return 0;
      }
      if (overrides.size === 0) {
        try {
          await this.#deactivate();
        } catch (error) {
          try {
            await this.#activate();
          } catch (restoreError) {
            logger?.(
              'Failed to restore network mocks after removal failed',
              restoreError,
            );
          }
          throw error;
        }
      }
      this.#overrides = overrides;
      return removed;
    });
  }

  async removeOwner(
    owner: object,
    options: {deferDeactivation?: boolean} = {},
  ): Promise<number> {
    return await this.#runLifecycleOperation(async () => {
      if (this.#disposed) {
        return 0;
      }
      const overrides = new Map(this.#overrides);
      for (const [id, override] of overrides) {
        if (override.owner === owner) {
          overrides.delete(id);
        }
      }
      const removed = this.#overrides.size - overrides.size;
      if (removed === 0) {
        return 0;
      }
      this.#overrides = overrides;
      if (overrides.size === 0 && !options.deferDeactivation) {
        try {
          await this.#deactivate();
        } catch (error) {
          try {
            await this.#activate();
          } catch (restoreError) {
            logger?.(
              'Failed to keep network interception active after owner cleanup failed',
              restoreError,
            );
          }
          throw error;
        }
      }
      return removed;
    });
  }

  async reconcile(): Promise<void> {
    await this.#runLifecycleOperation(async () => {
      if (this.#disposed || this.#overrides.size > 0) {
        return;
      }
      await this.#deactivate();
    });
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) {
      return this.#disposePromise;
    }
    this.#disposed = true;
    this.#overrides.clear();
    this.#removeListeners();
    this.#disposePromise = this.#runLifecycleOperation(async () => {
      this.#overrides.clear();
      await this.#deactivate();
    }).catch(error => {
      this.#disposed = false;
      this.#disposePromise = undefined;
      if (!this.#isPageClosed()) {
        if (this.#active) {
          this.#page.on('request', this.#requestHandler);
        }
        this.#page.on('close', this.#pageCloseHandler);
      }
      throw error;
    });
    return this.#disposePromise;
  }

  #isPageClosed(): boolean {
    return this.#pageClosed || this.#page.isClosed();
  }

  async #runLifecycleOperation<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    using guard = await this.#lifecycleMutex.acquire();
    return await operation();
  }

  async #activate(): Promise<void> {
    if (this.#disposed) {
      throw new Error('Cannot update mocks after the page was disposed.');
    }
    if (this.#active) {
      return;
    }
    if (this.#isPageClosed()) {
      throw new Error('Cannot add a network mock to a closed page.');
    }

    this.#page.on('request', this.#requestHandler);
    this.#page.on('close', this.#pageCloseHandler);
    try {
      this.#cacheDisabled = true;
      await this.#page.setCacheEnabled(false);
      if (this.#disposed) {
        throw new Error('Cannot update mocks after the page was disposed.');
      }
      this.#active = true;
      await this.#page.setRequestInterception(true);
      if (this.#disposed) {
        throw new Error('Cannot update mocks after the page was disposed.');
      }
    } catch (error) {
      try {
        await this.#deactivate();
      } catch (cleanupError) {
        logger?.('Failed to clean up network mock activation', cleanupError);
      }
      throw error;
    }
  }

  async #deactivate(): Promise<void> {
    if (this.#isPageClosed()) {
      this.#active = false;
      this.#cacheDisabled = false;
      this.#removeListeners();
      return;
    }

    if (this.#active) {
      await this.#page.setRequestInterception(false);
      this.#active = false;
    }
    this.#removeListeners();
    if (this.#cacheDisabled) {
      await this.#page.setCacheEnabled(true);
      this.#cacheDisabled = false;
    }
  }

  #findOverride(request: HTTPRequest): StoredNetworkOverride | undefined {
    const overrides = [...this.#overrides.values()];
    for (let index = overrides.length - 1; index >= 0; index--) {
      const override = overrides[index];
      if (!override) {
        continue;
      }
      if (!override.matcher.test(request.url())) {
        continue;
      }
      if (
        override.resourceType &&
        override.resourceType !== request.resourceType()
      ) {
        continue;
      }
      return override;
    }
    return undefined;
  }

  #removeListeners(): void {
    this.#page.off('request', this.#requestHandler);
    this.#page.off('close', this.#pageCloseHandler);
  }

  async #handleRequest(request: HTTPRequest): Promise<void> {
    if (
      request.resourceType() === 'document' &&
      request.frame() === this.#page.mainFrame()
    ) {
      for (const override of this.#overrides.values()) {
        override.diagnostics.navigations++;
      }
    }
    if (request.isInterceptResolutionHandled()) {
      return;
    }

    const override = this.#findOverride(request);
    if (!override) {
      await this.#continueRequest(request);
      return;
    }

    override.diagnostics.hits++;
    try {
      const body = await override.loadResponseFile();
      if (this.#disposed || this.#overrides.get(override.id) !== override) {
        await this.#continueRequest(request);
        return;
      }
      await request.respond({
        status: 200,
        contentType: override.contentType,
        headers: {
          'Cache-Control': 'no-store',
        },
        body,
      });
    } catch (error) {
      if (this.#disposed || this.#overrides.get(override.id) !== override) {
        await this.#continueRequest(request);
        return;
      }
      const message =
        typeof error === 'object' &&
        error !== null &&
        'message' in error &&
        typeof error.message === 'string'
          ? error.message
          : String(error);
      const source = override.responseFilePath;
      override.diagnostics.errors++;
      override.diagnostics.lastError =
        'Failed to load ' + source + ': ' + message;
      logger?.('Failed to apply network mock ' + override.id);
      await this.#abortRequest(request);
    }
  }

  async #continueRequest(request: HTTPRequest): Promise<void> {
    if (request.isInterceptResolutionHandled()) {
      return;
    }
    try {
      await request.continue();
    } catch (error) {
      logger?.('Failed to continue an intercepted network request', error);
    }
  }

  async #abortRequest(request: HTTPRequest): Promise<void> {
    if (request.isInterceptResolutionHandled()) {
      return;
    }
    try {
      await request.abort('failed');
    } catch (error) {
      logger?.('Failed to abort a request after a network mock error', error);
    }
  }
}

export async function acquireNetworkOverrideManager(
  page: Page,
  owner: object,
): Promise<NetworkOverrideManager> {
  if (page.isClosed()) {
    throw new Error('Cannot add a network mock to a closed page.');
  }
  let entry = managersByPage.get(page);
  if (entry?.disposalPromise) {
    try {
      await entry.disposalPromise;
    } catch {
      // A failed teardown leaves the existing manager available for reuse.
    }
    entry = managersByPage.get(page);
  }
  if (page.isClosed()) {
    throw new Error('Cannot add a network mock to a closed page.');
  }
  if (!entry) {
    entry = {manager: new NetworkOverrideManager(page), owners: new Set()};
    managersByPage.set(page, entry);
  }
  entry.owners.add(owner);
  return entry.manager;
}

async function disposeNetworkOverrideManagerEntry(
  page: Page,
  entry: SharedNetworkOverrideManagerEntry,
): Promise<void> {
  if (!entry.disposalPromise) {
    entry.disposalPromise = entry.manager.dispose();
  }
  try {
    await entry.disposalPromise;
  } catch (error) {
    entry.disposalPromise = undefined;
    throw error;
  }
  if (managersByPage.get(page) === entry) {
    managersByPage.delete(page);
  }
}

export async function releaseNetworkOverrideManager(
  page: Page,
  owner: object,
  options: {deferDeactivation?: boolean} = {},
): Promise<void> {
  const entry = managersByPage.get(page);
  if (!entry || !entry.owners.delete(owner)) {
    return;
  }
  const deferDeactivation = options.deferDeactivation ?? false;
  if (entry.owners.size > 0 || deferDeactivation) {
    await entry.manager.removeOwner(owner, {deferDeactivation});
    return;
  }
  await disposeNetworkOverrideManagerEntry(page, entry);
}

export function listNetworkOverrides(page: Page): NetworkOverride[] {
  return managersByPage.get(page)?.manager.list() ?? [];
}

export async function reconcileNetworkOverrideManager(
  page: Page,
): Promise<void> {
  const entry = managersByPage.get(page);
  if (!entry) {
    return;
  }
  if (entry.disposalPromise) {
    await entry.disposalPromise;
    if (managersByPage.get(page) !== entry) {
      return;
    }
  }
  if (entry.owners.size === 0) {
    await disposeNetworkOverrideManagerEntry(page, entry);
    return;
  }
  await entry.manager.reconcile();
}
