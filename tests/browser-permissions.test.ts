import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BrowserPermissions } from '../electron/browser-permissions';

class Contents extends EventEmitter {
  destroyed = false;
  url = 'https://workspace.example/page';
  isDestroyed() {
    return this.destroyed;
  }
  getURL() {
    return this.url;
  }
}

function fixture() {
  const tab = new Contents();
  let owned = true;
  let changes = 0;
  let request!: (...args: any[]) => void;
  let check!: (...args: any[]) => boolean;
  const controller = new BrowserPermissions(
    (wc) => owned && wc === (tab as unknown as Electron.WebContents),
    () => changes++,
  );
  controller.install({
    setPermissionRequestHandler(handler: typeof request) {
      request = handler;
    },
    setPermissionCheckHandler(handler: typeof check) {
      check = handler;
    },
  } as unknown as Electron.Session);
  const wc = tab as unknown as Electron.WebContents;
  const ask = (permission: string, details: object = {}, callback?: (value: boolean) => void) => {
    const decisions: boolean[] = [];
    request(
      wc,
      permission,
      (value: boolean) => {
        decisions.push(value);
        callback?.(value);
      },
      { requestingUrl: tab.url, isMainFrame: true, ...details },
    );
    return decisions;
  };
  return {
    tab,
    wc,
    controller,
    ask,
    check: (permission: string, target: unknown = wc, origin = 'https://workspace.example') =>
      check(target, permission, origin, {}),
    request,
    revoke: () => {
      owned = false;
    },
    get changes() {
      return changes;
    },
  };
}

test('routine permissions require an owned live browser and a web origin', (t) => {
  const f = fixture();
  t.after(() => f.controller.close());
  for (const permission of [
    'fullscreen',
    'clipboard-sanitized-write',
    'persistent-storage',
    'screen-wake-lock',
  ]) {
    assert.equal(f.check(permission), true);
    assert.deepEqual(f.ask(permission), [true]);
    assert.equal(f.check(permission, null), false);
    assert.equal(f.check(permission, new Contents()), false);
    assert.equal(f.check(permission, f.wc, 'file:///private/file'), false);
  }
  assert.equal(f.check('clipboard-read'), false);
  assert.deepEqual(f.ask('display-capture'), [false]);
  assert.deepEqual(f.ask('usb'), [false]);
  assert.deepEqual(f.ask('notifications', { requestingUrl: 'data:text/html,hello' }), [false]);
  assert.equal(f.controller.list(f.wc).length, 0);
  f.revoke();
  assert.deepEqual(f.ask('fullscreen'), [false]);
  assert.equal(f.check('fullscreen'), false);
});

test('sensitive requests wait for an explicit UI response and expose the requesting frame origin', (t) => {
  const f = fixture();
  t.after(() => f.controller.close());
  const decisions = f.ask('media', {
    requestingUrl: 'https://top.example/frame?token=private',
    securityOrigin: 'https://camera.example',
    mediaTypes: ['video', 'audio'],
    isMainFrame: false,
  });
  assert.deepEqual(decisions, []);
  const request = f.controller.list(f.wc)[0];
  assert.equal(request.origin, 'https://camera.example');
  assert.equal(request.detail, 'video, audio');
  assert.equal(request.label, 'Usar cámara o micrófono');
  assert.ok(!JSON.stringify(request).includes('private'));
  request.origin = 'mutated';
  assert.equal(f.controller.list(f.wc)[0].origin, 'https://camera.example');
  assert.throws(
    () => f.controller.respond(new Contents() as unknown as Electron.WebContents, request.id, true),
    /no está activa/,
  );
  f.controller.respond(f.wc, request.id, true);
  assert.deepEqual(decisions, [true]);
  assert.equal(f.controller.list(f.wc).length, 0);
  assert.throws(() => f.controller.respond(f.wc, request.id, true), /no está activa/);
  assert.equal(
    f.check('media'),
    false,
    'An individual consent does not become a permanent blanket grant',
  );
});

test('unknown iframe origins cannot borrow the top page identity; selected-file scope is shown', (t) => {
  const f = fixture();
  t.after(() => f.controller.close());
  assert.deepEqual(f.ask('geolocation', { requestingUrl: '', isMainFrame: false }), [false]);
  assert.deepEqual(
    f.ask('media', { requestingUrl: 'https://trusted.example', securityOrigin: 'null' }),
    [false],
  );
  const file = f.ask('fileSystem', {
    requestingUrl: 'https://files.example/picker',
    fileAccessType: 'writable',
    filePath: '/Users/test/document.txt',
    isMainFrame: false,
  });
  const pending = f.controller.list(f.wc)[0];
  assert.equal(pending.origin, 'https://files.example');
  assert.equal(pending.detail, 'Escritura: /Users/test/document.txt');
  f.controller.respond(f.wc, pending.id, false);
  assert.deepEqual(file, [false]);
});

test('navigation and destruction cancel requests, clean listeners, and reject old IDs', (t) => {
  const f = fixture();
  t.after(() => f.controller.close());
  const main = f.ask('notifications');
  const id = f.controller.list(f.wc)[0].id;
  f.tab.emit('did-start-navigation', {}, 'https://frame.example/', false, false);
  assert.deepEqual(
    main,
    [],
    'An unrelated iframe navigation should not cancel the main frame request',
  );
  f.tab.emit('did-start-navigation', {}, 'https://other.example/', false, true);
  assert.deepEqual(main, [false]);
  assert.throws(() => f.controller.respond(f.wc, id, true), /no está activa/);
  const frame = f.ask('clipboard-read', {
    requestingUrl: 'https://frame.example/',
    isMainFrame: false,
  });
  f.tab.emit('did-start-navigation', {}, 'https://frame.example/next', false, false);
  assert.deepEqual(frame, [false]);
  const last = f.ask('geolocation');
  f.tab.destroyed = true;
  f.tab.emit('destroyed');
  assert.deepEqual(last, [false]);
  assert.equal(f.tab.listenerCount('destroyed'), 0);
  assert.equal(f.tab.listenerCount('did-start-navigation'), 0);
  assert.deepEqual(f.ask('notifications'), [false]);
});

test('timeouts and the queue limit deny instead of leaving native permission callbacks hanging', (t) => {
  const f = fixture();
  t.after(() => f.controller.close());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const decisions = Array.from({ length: 5 }, () => f.ask('notifications'));
  assert.equal(f.controller.list(f.wc).length, 5);
  assert.deepEqual(f.ask('notifications'), [false]);
  t.mock.timers.tick(90000);
  assert.deepEqual(
    decisions,
    Array.from({ length: 5 }, () => [false]),
  );
  assert.equal(f.controller.list(f.wc).length, 0);
  assert.equal(f.tab.listenerCount('did-start-navigation'), 0);
});

test('ownership is rechecked at approval, and native callback errors cannot prevent shutdown cleanup', () => {
  const f = fixture();
  const revoked = f.ask('notifications');
  const id = f.controller.list(f.wc)[0].id;
  f.revoke();
  f.controller.respond(f.wc, id, true);
  assert.deepEqual(revoked, [false]);
  f.controller.close();

  const g = fixture();
  let throws = 0;
  g.ask('notifications', {}, () => {
    throws++;
    throw new Error('Frame destroyed');
  });
  const remaining = g.ask('clipboard-read');
  assert.doesNotThrow(() => g.controller.close());
  assert.equal(throws, 1);
  assert.deepEqual(remaining, [false]);
  assert.equal(g.controller.list(g.wc).length, 0);
  assert.equal(g.tab.listenerCount('destroyed'), 0);
  assert.equal(g.check('fullscreen'), false);
  assert.deepEqual(g.ask('notifications'), [false]);
  assert.deepEqual(g.ask('fullscreen'), [false]);
});
