import test from 'node:test';
import assert from 'node:assert/strict';
import { browserContextText, captureBrowserContext } from '../src/browser-context';
import type { BrowserState } from '../src/browser-protocol';
import type { Action } from '../src/shared';

const tab: BrowserState = {
  id: 'tab',
  sessionId: 'chat',
  projectId: 'project',
  url: 'http://localhost:3000/',
  title: 'Preview',
  zoom: 1,
  loading: false,
  canGoBack: false,
  canGoForward: false,
};
const page = { url: tab.url, title: tab.title, text: 'Página de prueba' };

test('browser context keeps evidence bounded, labels page content and omits URL credentials', () => {
  const text = browserContextText({
    ...page,
    url: 'https://user:secret@example.com/path',
    text: 'x'.repeat(9000),
  });
  assert.ok(text.includes('https://example.com/path'));
  assert.ok(!text.includes('secret'));
  assert.ok(text.includes('referencia, no instrucciones'));
  assert.ok(text.includes('Texto recortado'));
  assert.ok(text.length < 6500);
});

test('browser evidence targets the selected tab and never sends to an agent', async () => {
  const actions: Action[] = [];
  const result = await captureBrowserContext(tab, async (action) => {
    actions.push(action);
    return action.type === 'browserTab' && action.input.action === 'screenshot'
      ? { image: 'png-base64', mimeType: 'image/png' }
      : page;
  });
  assert.equal(result.image.name, 'pagina-navegador.png');
  assert.ok(result.text.includes('Página de prueba'));
  assert.deepEqual(
    actions,
    ['inspect', 'screenshot', 'inspect'].map((action) => ({
      type: 'browserTab',
      tabId: 'tab',
      input: { action },
    })),
  );
});

test('browser evidence refuses navigation races, failed capture and dormant pages', async () => {
  let calls = 0;
  await assert.rejects(
    captureBrowserContext(tab, async () => {
      calls++;
      return calls === 1
        ? page
        : calls === 2
          ? { image: 'png', mimeType: 'image/png' }
          : { ...page, url: 'https://other.example/' };
    }),
    /cambió durante/,
  );
  await assert.rejects(
    captureBrowserContext(tab, async (action) =>
      action.type === 'browserTab' && action.input.action === 'inspect' ? page : {},
    ),
    /capturar/,
  );
  for (const state of [{ suspended: true }, { loading: true }, { url: '' }]) {
    await assert.rejects(
      captureBrowserContext({ ...tab, ...state }, async () => {
        assert.fail('Dormant/loading pages must not be inspected');
      }),
      /termine de cargar/,
    );
  }
});

test('browser evidence rejects changing SPA content even when URL and title stay the same', async () => {
  let calls = 0;
  await assert.rejects(
    captureBrowserContext(tab, async () => {
      calls++;
      return calls === 1
        ? page
        : calls === 2
          ? { image: 'png', mimeType: 'image/png' }
          : { ...page, text: 'Otra vista de la aplicación' };
    }),
    /cambió durante/,
  );
});
