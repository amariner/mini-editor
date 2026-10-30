import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BrowserDialogs } from '../electron/browser-dialogs';

function fixture() {
  const replies: { accept: boolean; text: string }[] = [];
  let nativeCalls = 0;
  const dialog = {
    showMessageBox: () => {
      nativeCalls++;
    },
  };
  const defaultHandler = (info: { dialogType: string }) => {
    void info.dialogType;
    dialog.showMessageBox();
  };
  const wc = Object.assign(new EventEmitter(), { isDestroyed: (): boolean => false });
  wc.on('-run-dialog', defaultHandler);
  const changes: unknown[] = [];
  const dialogs = new BrowserDialogs(wc as unknown as Electron.WebContents, (value) =>
    changes.push(value),
  );
  const open = (type = 'confirm', message = 'Aceptar condiciones', defaultPrompt = '') =>
    wc.emit(
      '-run-dialog',
      {
        dialogType: type,
        messageText: message,
        frame: { url: 'https://example.com/' },
        defaultPromptText: defaultPrompt,
      },
      (accept: boolean, text: string) => replies.push({ accept, text }),
    );
  return { wc, replies, changes, dialogs, open, defaultHandler, nativeCalls: () => nativeCalls };
}

test('native dialog releases the action queue and requires an exact current dialog ID', async () => {
  const f = fixture();
  assert.equal(f.dialogs.supported, true);
  const pending = f.dialogs.race(new Promise(() => {}));
  f.open();
  const result = (await pending) as { dialog: { id: string; type: string } };
  assert.equal(result.dialog.type, 'confirm');
  await assert.rejects(f.dialogs.respond('stale', true), /ya no está abierto/);
  assert.equal(f.replies.length, 0);
  await f.dialogs.respond(result.dialog.id, true);
  assert.deepEqual(f.replies, [{ accept: true, text: '' }]);
  assert.equal(f.dialogs.current, undefined);
  assert.equal(f.nativeCalls(), 0);
  f.dialogs.dispose();
  assert.deepEqual(f.wc.listeners('-run-dialog'), [f.defaultHandler]);
});

test('prompt supports text and cancellation while confirm cannot receive text', async () => {
  const f = fixture();
  f.open('prompt', 'Nombre', 'Inicial');
  await f.dialogs.respond(f.dialogs.current!.id, true, 'Mi respuesta');
  assert.deepEqual(f.replies.at(-1), { accept: true, text: 'Mi respuesta' });
  f.open('prompt', 'Nombre', 'Inicial');
  await f.dialogs.respond(f.dialogs.current!.id, false, 'No enviar');
  assert.deepEqual(f.replies.at(-1), { accept: false, text: '' });
  f.open();
  await assert.rejects(f.dialogs.respond(f.dialogs.current!.id, true, 'No válido'), /no admite/);
  f.dialogs.dispose();
});

test('dialog content is bounded, cancelling clears state, and destroying releases pending operations', async () => {
  const f = fixture();
  f.open('alert', 'x'.repeat(10000));
  assert.equal(f.dialogs.current!.message.length, 5000);
  f.wc.emit('-cancel-dialogs');
  assert.equal(f.dialogs.current, undefined);
  assert.equal(
    f.replies.length,
    0,
    'Chromium cancellation must not run the native callback a second time',
  );
  const pending = f.dialogs.race(new Promise(() => {}));
  f.wc.isDestroyed = () => true;
  f.wc.emit('destroyed');
  await assert.rejects(pending, /se ha cerrado/);
  assert.equal(f.wc.listenerCount('-run-dialog'), 0);
});

test('unknown Electron dialog implementation retains native fallback unchanged', () => {
  const wc = Object.assign(new EventEmitter(), { isDestroyed: (): boolean => false });
  const futureNativeHandler = () => {};
  wc.on('-run-dialog', futureNativeHandler);
  const dialogs = new BrowserDialogs(wc as unknown as Electron.WebContents, () => {});
  assert.equal(dialogs.supported, false);
  assert.deepEqual(wc.listeners('-run-dialog'), [futureNativeHandler]);
  dialogs.dispose();
  assert.deepEqual(wc.listeners('-run-dialog'), [futureNativeHandler]);
});

test('the scoped prompt bridge preserves empty answers and cancels on renderer loss', async () => {
  const f = fixture();
  const event = {
    sender: f.wc,
    senderFrame: { url: 'https://example.com/form' },
    returnValue: undefined as unknown,
  };
  f.wc.emit('ipc-message-sync', event, 'agent-desk:browser-prompt', 'Nombre', 'Inicial');
  assert.equal(f.dialogs.current?.type, 'prompt');
  assert.equal(f.dialogs.current?.url, 'https://example.com/form');
  await f.dialogs.respond(f.dialogs.current!.id, true, '');
  assert.equal(event.returnValue, '');
  for (const cancellation of ['-cancel-dialogs', 'render-process-gone']) {
    event.returnValue = undefined;
    f.wc.emit('ipc-message-sync', event, 'agent-desk:browser-prompt', 'Nombre', 'Inicial');
    f.wc.emit(cancellation);
    assert.equal(event.returnValue, null);
    assert.equal(f.dialogs.current, undefined);
  }
  f.dialogs.dispose();
});

test('the prompt bridge rejects foreign senders, missing frames and unbounded messages', () => {
  const f = fixture();
  for (const [overrides, message, initial] of [
    [{ sender: {} }, 'Nombre', ''],
    [{ senderFrame: null }, 'Nombre', ''],
    [{}, 'x'.repeat(5001), ''],
    [{}, 'Nombre', 'x'.repeat(20001)],
  ] as const) {
    const event = {
      sender: f.wc,
      senderFrame: { url: 'https://example.com/' },
      returnValue: undefined as unknown,
      ...overrides,
    };
    f.wc.emit('ipc-message-sync', event, 'agent-desk:browser-prompt', message, initial);
    assert.equal(event.returnValue, null);
    assert.equal(f.dialogs.current, undefined);
  }
  const unrelated = { returnValue: undefined };
  f.wc.emit('ipc-message-sync', unrelated, 'another-channel', 'message', '');
  assert.equal(unrelated.returnValue, undefined);
  f.dialogs.dispose();
});

test('prompt still works when a newer Electron native dialog handler is unrecognized', async () => {
  const wc = Object.assign(new EventEmitter(), { isDestroyed: (): boolean => false });
  const futureNativeHandler = () => {};
  wc.on('-run-dialog', futureNativeHandler);
  const dialogs = new BrowserDialogs(wc as unknown as Electron.WebContents, () => {});
  const event = {
    sender: wc,
    senderFrame: { url: 'https://example.com' },
    returnValue: undefined as unknown,
  };
  wc.emit('ipc-message-sync', event, 'agent-desk:browser-prompt', 'Nombre', 'Inicial');
  await dialogs.respond(dialogs.current!.id, false);
  assert.equal(event.returnValue, null);
  assert.deepEqual(wc.listeners('-run-dialog'), [futureNativeHandler]);
  dialogs.dispose();
  assert.equal(wc.listenerCount('ipc-message-sync'), 0);
});
