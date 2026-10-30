import test from 'node:test';
import assert from 'node:assert/strict';
import { chromeContinuation } from '../src/chrome-continuation';
import type { BrowserState } from '../src/browser-protocol';
import type { ChromeConnection } from '../src/chrome-types';

const source: BrowserState = {
  id: 'internal',
  projectId: 'p',
  sessionId: 's',
  url: 'https://app.example/report',
  title: 'Report',
  zoom: 1,
  loading: false,
  canGoBack: false,
  canGoForward: false,
};
const connection: ChromeConnection = {
  id: 'c',
  projectId: 'p',
  mode: 'personal',
  status: 'connected',
  tabCount: 1,
};
const chrome: BrowserState = { ...source, id: 'external', backend: 'chrome', connectionId: 'c' };

test('continue uses the exact connected tab, or opens the requested page without navigating another tab', () => {
  assert.deepEqual(chromeContinuation(source, connection, [chrome]), {
    url: source.url,
    tabId: 'external',
  });
  for (const tab of [
    { ...chrome, url: 'https://app.example/unsaved' },
    { ...chrome, connectionId: 'other' },
    { ...chrome, projectId: 'other' },
  ])
    assert.deepEqual(chromeContinuation(source, connection, [tab]), {
      url: source.url,
      tabId: undefined,
    });
});

test('OAuth continuation uses the app origin and may reuse an authenticated page', () => {
  const auth = {
    ...source,
    url: 'https://accounts.google.com/oauth/authorize?code=secret&state=secret',
    externalUrl: source.url,
  };
  assert.deepEqual(chromeContinuation(auth, connection, [chrome]), {
    url: 'https://app.example/',
    tabId: 'external',
  });
  assert.deepEqual(
    chromeContinuation(auth, connection, [{ ...chrome, url: 'https://app.example/login' }]),
    {
      url: 'https://app.example/',
      tabId: undefined,
    },
  );
});

test('continuation refuses disconnected connections, other projects and privileged URLs', () => {
  assert.throws(() => chromeContinuation(source, { ...connection, projectId: 'other' }, []));
  assert.throws(() => chromeContinuation(source, { ...connection, status: 'disconnected' }, []));
  assert.throws(() => chromeContinuation({ ...source, url: 'file:///etc/passwd' }, connection, []));
});
