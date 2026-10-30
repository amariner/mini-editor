import test from 'node:test';
import assert from 'node:assert/strict';
import {
  browserInput,
  browserURL,
  browserPartition,
  externalBrowserURL,
  isAuthenticationURL,
} from '../src/browser-protocol';
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

test('pestañas explícitas, zoom acotado y operaciones de memoria', () => {
  for (const input of [
    { action: 'new', url: 'https://example.com' },
    { action: 'zoom', factor: 0.75 },
    { action: 'list' },
    { action: 'suspend', tabId: 'tab' },
  ])
    assert.equal(browserInput.safeParse(input).success, true);
  for (const factor of [0, 0.1, 4, NaN])
    assert.equal(browserInput.safeParse({ action: 'zoom', factor }).success, false);
  assert.equal(
    actionSchema.safeParse({ type: 'browserTab', tabId: 'tab', input: { action: 'inspect' } })
      .success,
    true,
  );
  assert.equal(actionSchema.safeParse({ type: 'browserNew', projectId: 'project' }).success, true);
});

test('perfiles persistentes por proyecto y salida externa sin reutilizar OAuth', () => {
  assert.equal(browserPartition('p'), 'persist:desk-browser-p');
  assert.notEqual(browserPartition('p'), browserPartition('q'));
  assert.equal(
    externalBrowserURL('https://app.example/reports?q=mes'),
    'https://app.example/reports?q=mes',
  );
  assert.equal(
    externalBrowserURL(
      'https://accounts.google.com/o/oauth2/v2/auth?state=private',
      'https://app.example/reports',
    ),
    'https://app.example/',
  );
  assert.equal(
    externalBrowserURL('https://app.example/api/auth/callback/google?code=private&state=test'),
    'https://app.example/',
  );
  assert.equal(
    externalBrowserURL('https://app.example/login?callbackUrl=%2Freport'),
    'https://app.example/',
  );
  assert.equal(
    externalBrowserURL('https://accounts.google.com/signin'),
    'https://accounts.google.com/',
  );
  assert.equal(isAuthenticationURL('https://not-google.example/accounts.google.com'), false);
  assert.throws(() => externalBrowserURL('file:///tmp/file'));
  assert.throws(() => externalBrowserURL('https://user:secret@example.com/'));
  assert.equal(actionSchema.safeParse({ type: 'browserOpenExternal', tabId: 'tab' }).success, true);
  assert.equal(
    actionSchema.safeParse({ type: 'browserOpenExternal', tabId: 'tab', url: 'file:///etc/passwd' })
      .success,
    false,
  );
  assert.equal(
    browserInput.safeParse({ action: 'openExternal', url: 'https://example.com' }).success,
    false,
  );
});

test('native browser controls require an unambiguous bounded target and supported inputs', () => {
  for (const input of [
    { action: 'click', x: 120.5, y: 90, clickCount: 2 },
    { action: 'click', ref: 'e1001', button: 'right' },
    { action: 'hover', ref: 'e1002' },
    { action: 'move', x: 0, y: 0 },
    { action: 'select', ref: 'e1003', value: 'pt' },
    { action: 'press', key: 'a', modifiers: ['meta'] },
    { action: 'press', key: 'PageDown' },
    { action: 'scroll', ref: 'e1004', deltaY: 200, deltaX: -100 },
  ])
    assert.equal(browserInput.safeParse(input).success, true, JSON.stringify(input));
  for (const input of [
    { action: 'click' },
    { action: 'click', ref: 'e1001', x: 1, y: 1 },
    { action: 'click', x: 1 },
    { action: 'hover', y: 1 },
    { action: 'move', x: Infinity, y: 2 },
    { action: 'move', x: -1, y: 2 },
    { action: 'click', ref: 'e1001', clickCount: 10 },
    { action: 'press', key: 'F12' },
    { action: 'press', key: 'a', modifiers: ['unsupported'] },
    { action: 'select', ref: 'arbitrary-selector', value: 'x' },
    { action: 'scroll', deltaY: 1, deltaX: 9000 },
  ])
    assert.equal(browserInput.safeParse(input).success, false, JSON.stringify(input));
});

test('browser workflow tools validate consent, files, drag, downloads and exact dialogs', () => {
  for (const input of [
    { action: 'check', ref: 'e1', checked: true },
    { action: 'upload', ref: 'e2', paths: ['report.pdf'] },
    { action: 'upload', ref: 'e2', paths: [] },
    { action: 'drag', ref: 'e3', toRef: 'e4' },
    { action: 'drag', x: 10, y: 20, toX: 30, toY: 40 },
    { action: 'download', url: 'https://example.com/report' },
    { action: 'downloads' },
    { action: 'downloadControl', downloadId: 'download', operation: 'cancel' },
    { action: 'dialog', dialogId: 'prompt', accept: true, promptText: 'Report' },
  ])
    assert.equal(browserInput.safeParse(input).success, true, JSON.stringify(input));
  for (const input of [
    { action: 'check', ref: 'e1' },
    { action: 'upload', ref: 'e2', paths: ['report.pdf'], userSelected: true },
    { action: 'upload', ref: 'e2', paths: Array(21).fill('file') },
    { action: 'drag', ref: 'e1', toX: 10 },
    { action: 'drag', ref: 'e1', toRef: 'e2', toX: 10, toY: 20 },
    { action: 'downloadControl', downloadId: 'download', operation: 'execute' },
    { action: 'dialog', accept: true },
    { action: 'permission', allow: true },
  ])
    assert.equal(browserInput.safeParse(input).success, false, JSON.stringify(input));
});
