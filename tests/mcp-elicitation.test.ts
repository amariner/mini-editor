import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  mcpElicitationFields,
  mcpElicitationResult,
  mcpElicitationUrl,
} from '../src/mcp-elicitation';
import { approvalResult, actionSchema } from '../electron/core';
import { ClaudeRuntime } from '../electron/claude';
import { Store } from '../electron/store';
import type { Session } from '../src/shared';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { McpElicitation } from '../src/mcp-elicitation-view';

const form = {
  mode: 'form',
  serverName: 'test',
  message: 'Elige los datos de la consulta',
  requestedSchema: {
    type: 'object',
    required: ['name', 'count', 'include'],
    properties: {
      name: { type: 'string', minLength: 2 },
      count: { type: 'integer', minimum: 1, maximum: 10 },
      include: { type: 'boolean' },
      category: { type: 'string', oneOf: [{ const: 'a', title: 'Categoría A' }, { const: 'b' }] },
      tags: { type: 'array', items: { type: 'string', enum: ['x', 'y'] }, minItems: 1 },
    },
  },
};
test('MCP forms validate typed answers before sending them to Codex', () => {
  const answers = { name: 'Ana', count: '3', include: 'false', category: 'a', tags: '["x"]' };
  assert.deepEqual(approvalResult('mcpServer/elicitation/request', form, 'accept', answers), {
    action: 'accept',
    content: { name: 'Ana', count: 3, include: false, category: 'a', tags: ['x'] },
  });
  for (const patch of [
    { count: '0' },
    { count: '2.5' },
    { count: 'Infinity' },
    { include: 'yes' },
    { name: '' },
    { category: 'c' },
    { tags: '["z"]' },
  ])
    assert.throws(() => mcpElicitationResult(form, 'accept', { ...answers, ...patch }));
  assert.deepEqual(mcpElicitationResult(form, 'decline'), { action: 'decline', content: null });
  assert.throws(() => mcpElicitationResult(form, 'always', answers));
});
test('unknown/complex forms can be declined but cannot accidentally be accepted', () => {
  for (const requestedSchema of [
    { type: 'object', properties: { x: { type: 'object' } } },
    { type: 'object', properties: {}, required: ['invisible'] },
    { type: 'object', properties: { x: { type: 'string', pattern: '(x+)+$' } } },
    { type: 'object', properties: {}, allOf: [] },
    JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}'),
  ]) {
    assert.throws(() => mcpElicitationFields({ requestedSchema }));
    assert.deepEqual(mcpElicitationResult({ requestedSchema }, 'decline'), {
      action: 'decline',
      content: null,
    });
  }
  assert.deepEqual(
    mcpElicitationResult({ requestedSchema: { type: 'object', properties: {} } }, 'accept'),
    { action: 'accept', content: {} },
  );
});
test('URL elicitation allows explicit HTTPS/loopback flows only', () => {
  assert.equal(
    mcpElicitationUrl({ mode: 'url', url: 'https://example.test/auth' }),
    'https://example.test/auth',
  );
  assert.equal(
    mcpElicitationUrl({ mode: 'url', url: 'http://127.0.0.1:9000/confirm' }),
    'http://127.0.0.1:9000/confirm',
  );
  for (const url of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'http://example.test/auth',
    'https://user:pass@example.test',
  ])
    assert.throws(() => mcpElicitationUrl({ mode: 'url', url }));
  assert.equal(
    actionSchema.safeParse({ type: 'openMcpElicitation', sessionId: 's', requestId: 1 }).success,
    true,
  );
});
test('standard titled multiselect and inherited object keys render and validate safely', () => {
  const params = {
    requestedSchema: {
      type: 'object',
      required: ['toString'],
      properties: {
        toString: { type: 'array', items: { anyOf: [{ const: 'a', title: 'Opción A' }] } },
        hasOwnProperty: { type: 'string' },
      },
    },
  };
  assert.throws(() => mcpElicitationResult(params, 'accept', {}), /Completa/);
  assert.deepEqual(mcpElicitationResult(params, 'accept', { toString: '["a"]' }), {
    action: 'accept',
    content: { toString: ['a'] },
  });
  const html = renderToStaticMarkup(
    React.createElement(McpElicitation, {
      approval: { id: 'a', method: 'mcpServer/elicitation/request', params },
      session: { id: 's' } as Session,
      run: async () => {},
    }),
  );
  assert.match(html, /Opción A/);
  assert.match(html, /multiple/);
  assert.doesNotMatch(html, /no podemos mostrar/);
});
test('Claude elicitation queues, resolves and cancels with the MCP response shape', async () => {
  const session: Session = {
    id: 's',
    title: 'Prueba',
    profile: 'claude-1',
    projectId: 'p',
    status: 'working',
    messages: [],
    approvals: [],
  };
  const runtime = new ClaudeRuntime(
    session,
    {},
    () => {},
    async () => {},
  );
  const controller = new AbortController();
  const first = (runtime as any).elicit(form, controller.signal);
  assert.equal(session.status, 'waiting');
  assert.throws(() => runtime.approve(session.approvals[0].id, 'accept', {}));
  assert.equal(session.approvals.length, 1);
  runtime.approve(session.approvals[0].id, 'accept', { name: 'Ana', count: '2', include: 'true' });
  assert.deepEqual(await first, {
    action: 'accept',
    content: { name: 'Ana', count: 2, include: true },
  });
  const next = (runtime as any).elicit(form, controller.signal);
  controller.abort();
  assert.deepEqual(await next, { action: 'cancel', content: null });
  assert.equal(session.approvals.length, 0);
  assert.equal(session.status, 'working');
  const interrupted = (runtime as any).elicit(form, new AbortController().signal);
  await runtime.interrupt();
  assert.deepEqual(await interrupted, { action: 'cancel', content: null });
});
test('Claude MCP transport diagnostics never return upstream credential bodies', async () => {
  const session = { info: {} } as Session;
  const runtime = new ClaudeRuntime(
    session,
    {},
    () => {},
    async () => {},
  );
  (runtime as any).query = {
    mcpServerStatus: async () => [
      { name: 'test', status: 'failed', error: 'Authorization: Bearer private-test-key' },
    ],
  };
  assert.doesNotMatch(JSON.stringify(await runtime.mcpStatus()), /private-test-key/);
  assert.doesNotMatch(JSON.stringify(session.info), /private-test-key/);
  const withCredentials = new ClaudeRuntime(
    session,
    {
      mcpServers: {
        test: {
          headers: { Authorization: 'Bearer private-test-key' },
          env: { TOKEN: 'private-env-key' },
        },
      },
    },
    () => {},
    async () => {},
  );
  assert.doesNotMatch(
    (withCredentials as any).diagnostic('Failed: private-test-key private-env-key'),
    /private-test-key|private-env-key/,
  );
});
test('project defaults and explicit empty chat overrides survive reload without runtime state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-mcp-store-'));
  try {
    const store = new Store(root);
    store.state.profiles = [{ id: 'claude-1', name: 'Claude', kind: 'claude' }];
    store.state.projects = [{ id: 'p', name: 'Project', path: root, mcpConnectionIds: ['c'] }];
    store.state.sessions = [
      {
        id: 's',
        title: 'Chat',
        projectId: 'p',
        profile: 'claude-1',
        status: 'ready',
        messages: [],
        approvals: [],
        mcpConnectionIds: [],
        mcpAppliedIds: ['c'],
        mcpPending: true,
      },
    ];
    store.state.mcpConnections = [];
    store.flush();
    const restored = new Store(root);
    assert.deepEqual(restored.state.projects[0].mcpConnectionIds, ['c']);
    assert.deepEqual(restored.state.sessions[0].mcpConnectionIds, []);
    assert.equal(restored.state.sessions[0].mcpAppliedIds, undefined);
    assert.equal(restored.state.sessions[0].mcpPending, undefined);
    assert.equal(restored.state.mcpConnections, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
