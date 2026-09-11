/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {afterEach, describe, it} from 'node:test';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {parseArguments} from '../src/config/mcp-options.js';
import {McpHttpServer} from '../src/McpHttpServer.js';

function testArgs() {
  return parseArguments(
    '0.0.0',
    ['node', 'test', '--headless', '--isolated', '--no-usage-statistics'],
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
