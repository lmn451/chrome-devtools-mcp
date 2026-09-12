/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {randomUUID} from 'node:crypto';
import type fs from 'node:fs';
import http from 'node:http';

import {BrowserManager} from './browser.js';
import type {ParsedArguments} from './config/mcp-options.js';
import {McpServer} from './index.js';
import {
  Client,
  InMemoryTransport,
  StreamableHTTPServerTransport,
  isInitializeRequest,
} from './third_party/index.js';
import {logger} from './utils/logger.js';
import {VERSION} from './version.js';

/** Matches the SDK's maximum message size for the streamable HTTP transport. */
const MAXIMUM_BODY_SIZE = 4 * 1024 * 1024;

const HOST = '127.0.0.1';
const MCP_PATH = '/mcp';
const HEALTH_PATH = '/health';
const API_TOOLS_PATH = '/api/tools';

/**
 * REST tool calls may run long-lived tools (Lighthouse audits, performance
 * traces), so the in-process MCP client gets a generous timeout instead of
 * the SDK's 60s default.
 */
const API_TOOL_CALL_TIMEOUT = 600_000;

/** Upper bound for the idle-session eviction sweep cadence. */
const MAX_EVICTION_SWEEP_INTERVAL = 60_000;

/**
 * REST sessions are addressed by a caller-chosen name; constrain it so names
 * stay usable in logs and URLs.
 */
const API_SESSION_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const DEFAULT_API_SESSION = 'default';

export interface McpHttpServerOptions {
  port: number;
  logFile?: fs.WriteStream;
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
}

interface ApiSession {
  client: Client;
  server: McpServer;
  /** Registered tool names, for fast 404s on unknown tools. */
  tools: Set<string>;
  lastActivity: number;
}

/**
 * Serves MCP over the streamable HTTP transport: one process, one browser,
 * any number of MCP clients. Every client gets its own session with an
 * isolated McpServer (tool state, roots, selected page) while all sessions
 * share a single BrowserManager and therefore a single Chrome instance.
 *
 * Besides the MCP endpoint (`/mcp`) the server exposes:
 * - `GET /health`: liveness/status for scripts and process managers.
 * - `GET /api/tools` and `POST /api/tools/<name>`: a REST facade for plain
 *   HTTP callers (curl/fetch/axios or agent CLIs) that maps straight onto
 *   MCP tool calls through an in-process MCP client, no handshake, session
 *   header, or SSE parsing required.
 */
export class McpHttpServer {
  #args: ParsedArguments;
  #options: McpHttpServerOptions;
  #browserManager = new BrowserManager();
  #sessions = new Map<string, McpSession>();
  #apiSessions = new Map<string, ApiSession>();
  #pendingApiSessions = new Map<string, Promise<ApiSession>>();
  #httpServer: http.Server;
  #startTime = Date.now();
  #evictionTimer: NodeJS.Timeout | undefined;
  #closed = false;

  private constructor(args: ParsedArguments, options: McpHttpServerOptions) {
    this.#args = args;
    this.#options = options;
    this.#httpServer = http.createServer((request, response) => {
      this.#handleRequest(request, response).catch(error => {
        logger?.('Error handling HTTP request', error);
        if (!response.headersSent) {
          respondJson(response, 500, {error: 'Internal server error'});
        }
      });
    });
  }

  static async start(
    args: ParsedArguments,
    options: McpHttpServerOptions,
  ): Promise<McpHttpServer> {
    const server = new McpHttpServer(args, options);
    await new Promise<void>((resolve, reject) => {
      server.#httpServer.once('error', reject);
      server.#httpServer.listen(options.port, HOST, () => {
        server.#httpServer.removeListener('error', reject);
        resolve();
      });
    });
    const timeoutMs = (args.httpSessionTimeout ?? 0) * 1000;
    if (timeoutMs > 0) {
      server.#evictionTimer = setInterval(
        () => {
          server.#evictIdleSessions(timeoutMs);
        },
        Math.min(timeoutMs, MAX_EVICTION_SWEEP_INTERVAL),
      );
      server.#evictionTimer.unref();
    }
    return server;
  }

  get port(): number {
    const address = this.#httpServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('HTTP server is not listening on a TCP port');
    }
    return address.port;
  }

  get url(): string {
    return `http://${HOST}:${this.port}${MCP_PATH}`;
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  get apiSessionCount(): number {
    return this.#apiSessions.size;
  }

  /**
   * Closes all client sessions, the shared browser and the HTTP listener.
   */
  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (this.#evictionTimer) {
      clearInterval(this.#evictionTimer);
      this.#evictionTimer = undefined;
    }
    const apiSessions = [...this.#apiSessions.values()];
    this.#apiSessions.clear();
    await Promise.allSettled(
      apiSessions.map(async ({client, server}) => {
        await client.close();
        await server.close();
      }),
    );
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.allSettled(sessions.map(({server}) => server.close()));
    await this.#browserManager.closeBrowser();
    await new Promise<void>((resolve, reject) => {
      this.#httpServer.close(error => (error ? reject(error) : resolve()));
      this.#httpServer.closeAllConnections();
    });
  }

  #evictIdleSessions(timeoutMs: number): void {
    const now = Date.now();
    for (const [sessionId, session] of [...this.#sessions]) {
      if (now - session.lastActivity <= timeoutMs) {
        continue;
      }
      logger?.(`Evicting idle MCP session: ${sessionId}`);
      // transport.close() triggers the transport's onclose handler, which
      // removes the session and closes its McpServer.
      void session.transport.close().catch(error => {
        logger?.('Error closing idle session', error);
      });
    }
    for (const [name, apiSession] of [...this.#apiSessions]) {
      if (now - apiSession.lastActivity <= timeoutMs) {
        continue;
      }
      logger?.(`Evicting idle REST session: ${name}`);
      this.#apiSessions.delete(name);
      void (async () => {
        await apiSession.client.close();
        await apiSession.server.close();
      })().catch(error => {
        logger?.('Error closing idle REST session', error);
      });
    }
  }

  #allowedHosts(): string[] {
    const port = this.port;
    return [`${HOST}:${port}`, `localhost:${port}`];
  }

  /**
   * DNS-rebinding protection for the non-MCP routes, mirroring the check the
   * SDK transport applies to `/mcp`: a malicious web page can make a browser
   * send requests to 127.0.0.1, but it cannot forge the Host header.
   */
  #isAllowedHost(request: http.IncomingMessage): boolean {
    const host = request.headers.host;
    return host !== undefined && this.#allowedHosts().includes(host);
  }

  async #handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${HOST}`);
    if (url.pathname === MCP_PATH) {
      // The MCP transport applies its own Host validation.
      await this.#handleMcpRequest(request, response);
      return;
    }
    if (!this.#isAllowedHost(request)) {
      respondJson(response, 403, {error: 'Invalid Host header'});
      return;
    }
    if (url.pathname === HEALTH_PATH && request.method === 'GET') {
      this.#handleHealth(response);
      return;
    }
    if (url.pathname === API_TOOLS_PATH && request.method === 'GET') {
      await this.#handleListTools(url, response);
      return;
    }
    if (
      url.pathname.startsWith(`${API_TOOLS_PATH}/`) &&
      request.method === 'POST'
    ) {
      await this.#handleCallTool(url, request, response);
      return;
    }
    respondJson(response, 404, {error: 'Not found'});
  }

  #handleHealth(response: http.ServerResponse): void {
    respondJson(response, 200, {
      status: 'ok',
      version: VERSION,
      uptimeSeconds: Math.round((Date.now() - this.#startTime) / 1000),
      mcpSessions: this.#sessions.size,
      apiSessions: this.#apiSessions.size,
      browserConnected: this.#browserManager.connected,
    });
  }

  async #handleListTools(
    url: URL,
    response: http.ServerResponse,
  ): Promise<void> {
    const sessionName = getApiSessionName(url);
    if (sessionName === undefined) {
      respondJson(response, 400, {error: 'Invalid session name'});
      return;
    }
    const apiSession = await this.#ensureApiSession(sessionName);
    const result = await apiSession.client.listTools();
    respondJson(response, 200, {tools: result.tools});
  }

  async #handleCallTool(
    url: URL,
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const sessionName = getApiSessionName(url);
    if (sessionName === undefined) {
      respondJson(response, 400, {error: 'Invalid session name'});
      return;
    }
    const toolName = url.pathname.slice(`${API_TOOLS_PATH}/`.length);
    if (!toolName || toolName.includes('/')) {
      respondJson(response, 404, {error: 'Not found'});
      return;
    }
    let body: string;
    try {
      body = await readBody(request);
    } catch (error) {
      logger?.('Failed to read request body', error);
      respondJson(response, 400, {error: 'Failed to read request body'});
      return;
    }
    let toolArguments: Record<string, unknown>;
    try {
      toolArguments = parseToolArguments(body);
    } catch (error) {
      respondJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const apiSession = await this.#ensureApiSession(sessionName);
    const decodedToolName = decodeURIComponent(toolName);
    if (!apiSession.tools.has(decodedToolName)) {
      respondJson(response, 404, {error: `Unknown tool: ${decodedToolName}`});
      return;
    }
    try {
      const result = await apiSession.client.callTool(
        {
          name: decodedToolName,
          arguments: toolArguments,
        },
        undefined,
        {timeout: API_TOOL_CALL_TIMEOUT},
      );
      // Tool execution errors surface as `isError: true` with HTTP 200,
      // mirroring MCP semantics; protocol errors (unknown tool, invalid
      // arguments) become HTTP 400 below.
      respondJson(response, 200, result);
    } catch (error) {
      respondJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * REST callers share long-lived in-process MCP sessions addressed by name
   * (`?session=<name>`, defaulting to a single shared session). The session
   * holds tool state (selected page, network/console history) between
   * invocations, which is what makes stateless CLI/script callers work.
   */
  async #ensureApiSession(name: string): Promise<ApiSession> {
    const existing = this.#apiSessions.get(name);
    if (existing) {
      existing.lastActivity = Date.now();
      return existing;
    }
    const pending = this.#pendingApiSessions.get(name);
    if (pending) {
      return await pending;
    }
    const creation = (async () => {
      const server = await McpServer.from(this.#args, {
        logFile: this.#options.logFile,
        browserManager: this.#browserManager,
      });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({
        name: 'chrome-devtools-mcp-rest',
        version: VERSION,
      });
      await client.connect(clientTransport);
      const toolList = await client.listTools();
      const apiSession: ApiSession = {
        client,
        server,
        tools: new Set(toolList.tools.map(tool => tool.name)),
        lastActivity: Date.now(),
      };
      this.#apiSessions.set(name, apiSession);
      logger?.(`REST session created: ${name}`);
      return apiSession;
    })();
    this.#pendingApiSessions.set(name, creation);
    try {
      return await creation;
    } finally {
      this.#pendingApiSessions.delete(name);
    }
  }

  async #handleMcpRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const sessionIdHeader = request.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionIdHeader)
      ? sessionIdHeader[0]
      : sessionIdHeader;
    if (sessionId !== undefined) {
      const session = this.#sessions.get(sessionId);
      if (!session) {
        respondJsonRpcError(response, 404, -32001, 'Session not found');
        return;
      }
      session.lastActivity = Date.now();
      await session.transport.handleRequest(request, response);
      return;
    }
    // Only an initialization POST may arrive without a session id; it opens
    // a new session.
    if (request.method !== 'POST') {
      respondJsonRpcError(
        response,
        400,
        -32000,
        'Bad Request: no valid session ID provided',
      );
      return;
    }
    let body: unknown;
    try {
      const rawBody = await readBody(request);
      body = JSON.parse(rawBody);
    } catch (error) {
      logger?.('Failed to read request body', error);
      respondJsonRpcError(response, 400, -32700, 'Parse error');
      return;
    }
    if (!isInitializeRequest(body)) {
      respondJsonRpcError(
        response,
        400,
        -32000,
        'Bad Request: no valid session ID provided',
      );
      return;
    }
    const transport = await this.#createSession();
    await transport.handleRequest(request, response, body);
  }

  async #createSession(): Promise<StreamableHTTPServerTransport> {
    const server = await McpServer.from(this.#args, {
      logFile: this.#options.logFile,
      browserManager: this.#browserManager,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: true,
      allowedHosts: this.#allowedHosts(),
      onsessioninitialized: sessionId => {
        logger?.(`MCP session initialized: ${sessionId}`);
        this.#sessions.set(sessionId, {
          transport,
          server,
          lastActivity: Date.now(),
        });
      },
    });
    let closing = false;
    transport.onclose = () => {
      if (closing) {
        return;
      }
      closing = true;
      const sessionId = transport.sessionId;
      if (sessionId !== undefined) {
        logger?.(`MCP session closed: ${sessionId}`);
        this.#sessions.delete(sessionId);
      }
      // Closes this session's McpServer only. The browser is shared and
      // stays up for the remaining sessions; it is owned by this
      // McpHttpServer and closed in close().
      void server.close().catch(error => {
        logger?.('Error closing session server', error);
      });
    };
    await server.connect(transport);
    return transport;
  }
}

function getApiSessionName(url: URL): string | undefined {
  const name = url.searchParams.get('session') ?? DEFAULT_API_SESSION;
  if (!API_SESSION_NAME_PATTERN.test(name)) {
    return undefined;
  }
  return name;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseToolArguments(body: string): Record<string, unknown> {
  if (body.trim() === '') {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('Tool arguments must be valid JSON');
  }
  if (!isPlainObject(parsed)) {
    throw new Error('Tool arguments must be a JSON object');
  }
  return parsed;
}

function respondJson(
  response: http.ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.writeHead(statusCode, {'Content-Type': 'application/json'});
  response.end(JSON.stringify(payload));
}

function respondJsonRpcError(
  response: http.ServerResponse,
  statusCode: number,
  code: number,
  message: string,
): void {
  respondJson(response, statusCode, {
    jsonrpc: '2.0',
    error: {code, message},
    id: null,
  });
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let data = '';
    let size = 0;
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > MAXIMUM_BODY_SIZE) {
        reject(new Error('Request body exceeds maximum size'));
        request.destroy();
        return;
      }
      data += chunk;
    });
    request.on('end', () => resolve(data));
    request.on('error', reject);
  });
}
