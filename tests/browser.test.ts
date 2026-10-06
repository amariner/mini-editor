import test from 'node:test';
import assert from 'node:assert/strict';
import { browserInput, browserURL } from '../src/browser-protocol';
import { actionSchema } from '../electron/core';
import { isCoordinationApproval } from '../electron/coordination';
test('browser URLs accept local previews and reject privileged schemes and credentials', () => {
  assert.equal(browserURL('localhost:3000/test'), 'http://localhost:3000/test');
  assert.equal(browserURL('https://example.com'), 'https://example.com/');
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,hi',
    'ftp://example.com',
    'https://user:password@example.com',
  ])
    assert.throws(() => browserURL(url));
});
test('browser controls are bounded actions, no arbitrary JS or other session identity in tool input', () => {
  assert.equal(
    browserInput.safeParse({ action: 'evaluate', script: 'process.env' }).success,
    false,
  );
  assert.equal(
    browserInput.safeParse({ action: 'click', ref: 'e1', sessionId: 'other' }).success,
    false,
  );
  assert.equal(browserInput.safeParse({ action: 'scroll', deltaY: 999999 }).success, false);
  assert.equal(
    actionSchema.safeParse({
      type: 'browserPresent',
      sessionId: 's',
      visible: true,
      bounds: { x: -1, y: 0, width: 10, height: 10 },
    }).success,
    false,
  );
  assert.equal(browserInput.safeParse({ action: 'fill', ref: 'e4', text: 'test' }).success, true);
});
test('browser approval is restricted to the installed local tool and validated inputs', () => {
  const p = {
    serverName: 'agent_desk',
    mode: 'form',
    message: 'Allow tool "browser"?',
    _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: { action: 'inspect' } },
    requestedSchema: { type: 'object', properties: {} },
  };
  assert.equal(isCoordinationApproval('mcpServer/elicitation/request', p), true);
  assert.equal(
    isCoordinationApproval('mcpServer/elicitation/request', { ...p, serverName: 'unknown' }),
    false,
  );
  assert.equal(
    isCoordinationApproval('mcpServer/elicitation/request', {
      ...p,
      _meta: { ...p._meta, tool_params: { action: 'evaluate' } },
    }),
    false,
  );
});
