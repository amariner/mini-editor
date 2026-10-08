import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Manager } from '../electron/manager';
import { Store } from '../electron/store';
import { sessionAccountLocked } from '../src/session-tabs';
import { actionSchema } from '../electron/core';

async function fixture(run: (m: Manager, root: string) => Promise<void>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'desk-session-account-')));
  const m = new Manager(root, () => {});
  m.addAccount('claude', 'Personal');
  m.addAccount('codex', 'Trabajo');
  m.state.projects.push({ id: 'p', name: 'Proyecto', path: root });
  try {
    await run(m, root);
  } finally {
    await m.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('new tabs use the persisted default, independent of the selected chat; deletion chooses another default', () =>
  fixture(async (m, root) => {
    assert.equal(m.newSession('p').profile, 'claude-1');
    m.setDefaultAccount('codex');
    const chat = m.newSession('p');
    assert.equal(chat.profile, 'codex');
    await m.changeSessionAccount(chat.id, 'claude-1');
    assert.equal(m.newSession('p').profile, 'codex');
    m.store.flush();
    assert.equal(new Store(root).state.defaultProfile, 'codex');
    assert.throws(() => m.setDefaultAccount('codex-99'), /disponible/);
    await m.removeAccount('codex', true, async () => {});
    assert.equal(m.state.defaultProfile, 'claude-1');
    assert.equal(new Store(root).state.defaultProfile, 'claude-1');
    await m.removeAccount('claude-1', true, async () => {});
    assert.equal(m.state.defaultProfile, undefined);
    assert.throws(() => m.newSession('p'), /Añade una cuenta/);
  }));

test('changing an empty chat preserves its id and title and resets provider state without creating a tab', () =>
  fixture(async (m) => {
    const chat = m.newSession('p');
    chat.title = 'Mi borrador';
    chat.error = 'Old error';
    const oldReference = chat.reference;
    const next = await m.changeSessionAccount(chat.id, 'codex');
    assert.equal(m.state.selectedSession, chat.id);
    assert.equal(m.state.sessions.length, 1);
    assert.equal(next.title, 'Mi borrador');
    assert.equal(next.reference, undefined);
    assert.equal(next.config, undefined);
    assert.ok(next.codexConfig);
    assert.equal(next.error, undefined);
    const restored = await m.changeSessionAccount(chat.id, 'claude-1');
    assert.notEqual(restored.reference, oldReference);
    assert.equal(restored.codexConfig, undefined);
    await assert.rejects(m.changeSessionAccount(chat.id, 'codex-99'), /disponible/);
    await m.exclusive(chat.id, () =>
      assert.rejects(m.changeSessionAccount(chat.id, 'codex'), /operación pendiente/),
    );
  }));

test('the first send locks the account durably even after clearing history and restarting', () =>
  fixture(async (m, root) => {
    const chat = m.newSession('p');
    chat.status = 'ready';
    m.runtimes.set(chat.id, {
      buffer: '',
      sequence: 0,
      claude: {
        send() {
          chat.messages.push({ id: 'u', role: 'user', text: 'Hola' });
        },
        async stop() {
          m.runtimes.delete(chat.id);
          chat.status = 'stopped';
        },
      } as any,
    });
    await m.send(chat.id, 'Hola');
    assert.equal(chat.accountLocked, true);
    await m.stop(chat.id);
    chat.messages = [];
    m.store.flush();
    const restored = new Store(root).state.sessions[0];
    assert.equal(sessionAccountLocked(restored), true);
    await assert.rejects(m.changeSessionAccount(chat.id, 'codex'), /Abre otra pestaña/);
    assert.equal(chat.profile, 'claude-1');
    assert.equal(sessionAccountLocked(m.newSession('p')), false);
  }));

test('legacy chats with history or remote threads stay locked and old settings get a default', () =>
  fixture(async (m, root) => {
    const chat = m.newSession('p', 'codex');
    chat.accountLocked = undefined;
    chat.reference = 'legacy-thread';
    m.state.defaultProfile = undefined;
    m.store.flush();
    const restored = new Store(root).state;
    assert.equal(restored.defaultProfile, 'claude-1');
    assert.equal(restored.sessions[0].accountLocked, true);
    assert.equal(
      actionSchema.safeParse({
        type: 'changeSessionAccount',
        sessionId: chat.id,
        profile: '../bad',
      }).success,
      false,
    );
    assert.equal(actionSchema.safeParse({ type: 'newSession', projectId: 'p' }).success, true);
  }));
