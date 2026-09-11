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
  StreamableHTTPServerTransport,
  isInitializeRequest,
} from './third_party/index.js';
import {logger} from './utils/logger.js';

/** Matches the SDK's maximum message size for the streamable HTTP transport. */
const MAXIMUM_BODY_SIZE = 4 * 1024 * 1024;

const HOST = '127.0.0.1';
const MCP_PATH = '/mcp';

export interface McpHttpServerOptions {
  port: number;
  logFile?: fs.WriteStream;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

/**
 * Serves MCP over the streamable HTTP transport: one process, one browser,
 * any number of MCP clients. Every client gets its own session with an
 * isolated McpServer (tool state, roots, selected page) while all sessions
 * share a single BrowserManager and therefore a single Chrome instance.
 */
export class McpHttpServer {
  #args: ParsedArguments;
  #options: McpHttpServerOptions;
  #browserManager = new BrowserManager();
  #sessions = new Map<string, Session>();
  #httpServer: http.Server;
  #closed = false;

  private constructor(args: ParsedArguments, options: McpHttpServerOptions) {
    this.#args = args;
    this.#options = options;
    this.#httpServer = http.createServer((request, response) => {
      this.#handleRequest(request, response).catch(error => {
        logger?.('Error handling HTTP request', error);
        if (!response.headersSent) {
          respondJsonRpcError(response, 500, -32603, 'Internal server error');
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

  /**
   * Closes all client sessions, the shared browser and the HTTP listener.
   */
  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.allSettled(sessions.map(({server}) => server.close()));
    await this.#browserManager.closeBrowser();
    await new Promise<void>((resolve, reject) => {
      this.#httpServer.close(error => (error ? reject(error) : resolve()));
      this.#httpServer.closeAllConnections();
    });
  }

  async #handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${HOST}`);
    if (url.pathname !== MCP_PATH) {
      respondJsonRpcError(response, 404, -32000, 'Not found');
      return;
    }
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
      body = await readJsonBody(request);
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
    const port = this.port;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: true,
      allowedHosts: [`${HOST}:${port}`, `localhost:${port}`],
      onsessioninitialized: sessionId => {
        logger?.(`MCP session initialized: ${sessionId}`);
        this.#sessions.set(sessionId, {transport, server});
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

function respondJsonRpcError(
  response: http.ServerResponse,
  statusCode: number,
  code: number,
  message: string,
): void {
  response.writeHead(statusCode, {'Content-Type': 'application/json'});
  response.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: {code, message},
      id: null,
    }),
  );
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const body = await new Promise<string>((resolve, reject) => {
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
  const parsed: unknown = JSON.parse(body);
  return parsed;
}
