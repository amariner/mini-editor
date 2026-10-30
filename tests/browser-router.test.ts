import test from 'node:test';
import assert from 'node:assert/strict';
import { routeBrowserForSession } from '../electron/browser-router';
import { actionSchema } from '../electron/core';
import type { BrowserState } from '../src/browser-protocol';
import type { ChromeConnection } from '../src/chrome-types';

const tab = (id: string, projectId: string): BrowserState => ({
  id,
  projectId,
  sessionId: 's',
  zoom: 1,
  url: 'https://example.com',
  title: id,
  loading: false,
  canGoBack: false,
  canGoForward: false,
});
function fixture() {
  const calls: unknown[][] = [];
  const backend = (name: string, tabs: BrowserState[]) => ({
    snapshot: () => tabs,
    downloadSnapshot: () => [],
    async forSession(...args: unknown[]) {
      calls.push([name, ...args]);
      return name;
    },
  });
  const integrated = backend('integrated', [tab('internal', 'p')]);
  const chrome = {
    ...backend('chrome', [tab('chrome-tab', 'p'), tab('private-tab', 'other')]),
    connections: (): ChromeConnection[] => [
      { id: 'c', mode: 'managed', status: 'connected', projectId: 'p', tabCount: 1 },
      { id: 'private', mode: 'personal', status: 'connected', projectId: 'other', tabCount: 1 },
    ],
  };
  const route = (input: unknown) => routeBrowserForSession(integrated, chrome, 's', 'p', input);
  return { calls, route };
}

test('browser discovery exposes only the requesting project across both backends', async () => {
  const { route, calls } = fixture();
  const result = (await route({ action: 'list' })) as any;
  assert.deepEqual(
    result.tabs.map((t: BrowserState) => t.id),
    ['internal', 'chrome-tab'],
  );
  assert.deepEqual(
    result.connections.map((c: ChromeConnection) => c.id),
    ['c'],
  );
  assert.deepEqual(calls, []);
});

test('Chrome tab identity routes native actions and rejects foreign or disconnected targets', async () => {
  const { route, calls } = fixture();
  assert.equal(await route({ action: 'click', tabId: 'chrome-tab', x: 10, y: 10 }), 'chrome');
  for (const tabId of ['private-tab', 'disconnected-tab'])
    await assert.rejects(
      route({ action: 'navigate', tabId, url: 'https://example.com' }),
      /proyecto/,
    );
  assert.equal(calls.length, 1);
  assert.equal(await route({ action: 'new', tabId: 'chrome-tab' }), 'chrome');
  assert.equal(await route({ action: 'new' }), 'integrated');
});

test('application and Chrome IPC cannot inject paths, commands, endpoints or privileged setup URLs', () => {
  for (const value of [
    { type: 'applicationInstall' },
    { type: 'applicationRefresh' },
    { type: 'applicationOpen', id: 'known' },
    { type: 'chromeConnect', mode: 'personal', projectId: 'p' },
    { type: 'chromeConnect', mode: 'managed' },
    { type: 'chromeSetup' },
    { type: 'chromeDisconnect', connectionId: 'c' },
  ])
    assert.equal(actionSchema.safeParse(value).success, true);
  for (const value of [
    { type: 'applicationInstall', path: '/Applications/Secret.app' },
    { type: 'applicationOpen', id: 'known', command: 'sudo' },
    { type: 'chromeConnect', mode: 'personal', endpoint: 'ws://remote:9222' },
    { type: 'chromeConnect', mode: 'managed', executablePath: '/tmp/script' },
    { type: 'chromeSetup', url: 'chrome://settings' },
  ])
    assert.equal(actionSchema.safeParse(value).success, false);
});
