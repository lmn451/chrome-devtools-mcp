/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import http from 'node:http';
import {afterEach, describe, it} from 'node:test';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {executablePath} from 'puppeteer';

import {parseArguments} from '../src/config/mcp-options.js';
import {McpHttpServer} from '../src/McpHttpServer.js';

function testArgs(extraArgs: string[] = []) {
  return parseArguments(
    '0.0.0',
    [
      'node',
      'test',
      '--headless',
      '--isolated',
      '--no-usage-statistics',
      ...extraArgs,
    ],
    {},
  );
}

async function connectClient(url: string) {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({name: 'http-test-client', version: '1.0.0'});
  await client.connect(transport);
  return {client, transport};
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Condition not met within timeout');
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('McpHttpServer', () => {
  let server: McpHttpServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('serves multiple concurrent sessions over one server', async () => {
    server = await McpHttpServer.start(testArgs(), {port: 0});

    const a = await connectClient(server.url);
    const b = await connectClient(server.url);

    assert.ok(a.transport.sessionId);
    assert.ok(b.transport.sessionId);
    assert.notStrictEqual(a.transport.sessionId, b.transport.sessionId);
    assert.strictEqual(server.sessionCount, 2);

    const toolsA = await a.client.listTools();
    const toolsB = await b.client.listTools();
    assert.ok(toolsA.tools.length > 0);
    assert.deepStrictEqual(
      toolsA.tools.map(tool => tool.name),
      toolsB.tools.map(tool => tool.name),
    );

    await a.client.close();
    await b.client.close();
  });

  it('keeps other sessions alive when one terminates', async () => {
    server = await McpHttpServer.start(testArgs(), {port: 0});
    const activeServer = server;

    const a = await connectClient(server.url);
    const b = await connectClient(server.url);
    assert.strictEqual(server.sessionCount, 2);

    await a.transport.terminateSession();
    await waitFor(() => activeServer.sessionCount === 1);

    const tools = await b.client.listTools();
    assert.ok(tools.tools.length > 0);

    await a.client.close();
    await b.client.close();
  });

  it('rejects non-initialize requests without a session id', async () => {
    server = await McpHttpServer.start(testArgs(), {port: 0});

    const response = await fetch(server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({jsonrpc: '2.0', method: 'tools/list', id: 1}),
    });
    await response.text();

    assert.strictEqual(response.status, 400);
    assert.strictEqual(server.sessionCount, 0);
  });

  it('rejects unknown session ids', async () => {
    server = await McpHttpServer.start(testArgs(), {port: 0});

    const response = await fetch(server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'unknown-session',
      },
      body: JSON.stringify({jsonrpc: '2.0', method: 'tools/list', id: 1}),
    });
    await response.text();

    assert.strictEqual(response.status, 404);
  });

  it('rejects requests outside the MCP path', async () => {
    server = await McpHttpServer.start(testArgs(), {port: 0});

    const response = await fetch(`http://127.0.0.1:${server.port}/other`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: '{}',
    });
    await response.text();

    assert.strictEqual(response.status, 404);
  });

  it('reports status on /health', async () => {
    server = await McpHttpServer.start(testArgs(), {port: 0});

    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    const text = await response.text();

    assert.strictEqual(response.status, 200);
    assert.ok(text.includes('"status":"ok"'));
    assert.ok(text.includes('"mcpSessions":0'));
    assert.ok(text.includes('"browserConnected":false'));
  });

  it('rejects foreign Host headers outside /mcp', async () => {
    server = await McpHttpServer.start(testArgs(), {port: 0});

    const statusCode = await new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: server?.port,
          path: '/health',
          headers: {Host: 'evil.example'},
        },
        response => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on('error', reject);
      request.end();
    });

    assert.strictEqual(statusCode, 403);
  });

  it('lists tools over the REST facade', async () => {
    server = await McpHttpServer.start(testArgs(), {port: 0});

    const response = await fetch(`http://127.0.0.1:${server.port}/api/tools`);
    const text = await response.text();

    assert.strictEqual(response.status, 200);
    assert.ok(text.includes('"list_pages"'));
    assert.ok(text.includes('"inputSchema"'));
    assert.strictEqual(server.apiSessionCount, 1);
  });

  it('rejects invalid REST tool calls', async () => {
    server = await McpHttpServer.start(testArgs(), {port: 0});
    const base = `http://127.0.0.1:${server.port}/api/tools`;

    const unknownTool = await fetch(`${base}/does_not_exist`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: '{}',
    });
    await unknownTool.text();
    assert.strictEqual(unknownTool.status, 404);

    const badArgs = await fetch(`${base}/list_pages`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: '[1,2]',
    });
    await badArgs.text();
    assert.strictEqual(badArgs.status, 400);

    const badSession = await fetch(`${base}/list_pages?session=bad/name`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: '{}',
    });
    await badSession.text();
    assert.strictEqual(badSession.status, 400);
  });

  it('calls tools over the REST facade with a shared browser', async () => {
    server = await McpHttpServer.start(
      testArgs(['--executable-path', await executablePath()]),
      {port: 0},
    );
    const base = `http://127.0.0.1:${server.port}/api/tools`;

    const newPage = await fetch(`${base}/new_page`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({url: 'about:blank?from-rest'}),
    });
    const newPageText = await newPage.text();
    assert.strictEqual(newPage.status, 200);
    assert.ok(!newPageText.includes('"isError":true'));

    // A different named REST session sees the same browser.
    const listPages = await fetch(`${base}/list_pages?session=other`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
    });
    const listPagesText = await listPages.text();
    assert.strictEqual(listPages.status, 200);
    assert.ok(listPagesText.includes('from-rest'));
    assert.strictEqual(server.apiSessionCount, 2);
  });

  it('evicts idle sessions after the configured timeout', async () => {
    server = await McpHttpServer.start(
      testArgs(['--http-port', '0', '--http-session-timeout', '1']),
      {port: 0},
    );
    const activeServer = server;

    const a = await connectClient(server.url);
    assert.strictEqual(server.sessionCount, 1);

    await waitFor(() => activeServer.sessionCount === 0, 5_000);

    await assert.rejects(async () => {
      await a.client.listTools();
    });
    await a.client.close();
  });

  it('closes all sessions on close', async () => {
    server = await McpHttpServer.start(testArgs(), {port: 0});
    const url = server.url;

    const a = await connectClient(url);
    assert.strictEqual(server.sessionCount, 1);

    await server.close();
    server = undefined;

    assert.strictEqual(a.transport.sessionId !== undefined, true);
    await assert.rejects(async () => {
      await a.client.listTools();
    });
    await a.client.close();
  });
});
