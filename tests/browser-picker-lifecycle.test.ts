import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { cancelBrowserPick, pickBrowserElement } from '../electron/browser-picker';

class Page extends EventEmitter {
  destroyed = false;
  isDestroyed() {
    return this.destroyed;
  }
  async executeJavaScriptInIsolatedWorld(_world: number, _scripts: unknown[], userGesture = false) {
    // A page with no selection leaves installation's promise pending indefinitely.
    if (userGesture) return new Promise(() => {});
  }
  contents() {
    return this as unknown as Electron.WebContents;
  }
}

test('cancelling a picker settles even when the page never resolves the injected selection promise', async () => {
  const page = new Page();
  const selection = pickBrowserElement(page.contents());
  await cancelBrowserPick(page.contents());
  assert.equal(await selection, null);
  assert.equal(page.listenerCount('did-start-navigation'), 0);
  assert.equal(page.listenerCount('destroyed'), 0);
});

test('a frame navigation keeps the picker active; main page navigation or destruction releases it', async () => {
  const page = new Page();
  let settled = false;
  const selection = pickBrowserElement(page.contents()).then((value) => {
    settled = true;
    return value;
  });
  page.emit('did-start-navigation', {}, 'https://example.com/frame', false, false);
  await Promise.resolve();
  assert.equal(settled, false);
  page.emit('did-start-navigation', {}, 'https://example.com/next', false, true);
  assert.equal(await selection, null);
  const next = pickBrowserElement(page.contents());
  page.destroyed = true;
  page.emit('destroyed');
  assert.equal(await next, null);
});

test('replacing a picker does not let the previous cleanup remove the current cancellation handle', async () => {
  const page = new Page();
  const previous = pickBrowserElement(page.contents());
  const current = pickBrowserElement(page.contents());
  assert.equal(await previous, null);
  await cancelBrowserPick(page.contents());
  assert.equal(await current, null);
  assert.equal(page.listenerCount('did-start-navigation'), 0);
});
