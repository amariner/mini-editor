import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { build } from 'esbuild';

test('descubrir puertos no carga Chromium y borrar el chat libera pestañas y sondeo', async () => {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL('../electron/browser.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['electron'],
  });
  const require = createRequire(import.meta.url);
  let renderers = 0;
  const module = { exports: {} as any };
  // Fail immediately if discovery tries to create a renderer. TCP probes stay local mocks.
  new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(
    (name: string) => {
      if (name === 'electron')
        return {
          WebContentsView: class {
            constructor() {
              renderers++;
              throw new Error('renderer requested');
            }
          },
          session: { fromPartition: () => ({}) },
        };
      if (name === 'node:net')
        return {
          createConnection() {
            const socket = Object.assign(new EventEmitter(), {
              setTimeout() {},
              destroy() {},
            });
            queueMicrotask(() => socket.emit('connect'));
            return socket;
          },
        };
      return require(name);
    },
    module,
    module.exports,
  );
  let opened = 0;
  const browser = new module.exports.DeskBrowser(
    () => undefined,
    () => {},
    () => {
      opened++;
    },
  );
  try {
    assert.equal(browser.monitor, undefined);
    await browser.observe('project', 'chat', 'Local: http://localhost:3000/');
    assert.equal(renderers, 0);
    assert.equal(opened, 0);
    const [tab] = browser.snapshot();
    assert.equal(tab.suspended, true);
    assert.equal(tab.hostStatus, 'online');
    assert.equal(browser.serverSnapshot().length, 1);
    assert.ok(browser.monitor);
    await assert.rejects(
      browser.action(tab.id, { action: 'navigate', url: tab.url }),
      /renderer requested/,
    );
    assert.equal(renderers, 1);
    await browser.removeSessions(['chat']);
    assert.deepEqual(browser.snapshot(), []);
    assert.deepEqual(browser.serverSnapshot(), []);
    assert.equal(browser.monitor, undefined);
  } finally {
    await browser.closeAll();
  }
});
