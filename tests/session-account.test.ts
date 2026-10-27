import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Manager } from '../electron/manager';
import { Store } from '../electron/store';
import { sessionAccountLocked } from '../src/session-tabs';
import { continuationContext } from '../electron/session-continuation';
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

test('a previously used account can be changed after clearing history and restarting', () =>
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
    const switched = await m.changeSessionAccount(chat.id, 'codex');
    assert.equal(switched.profile, 'codex');
    assert.equal(switched.id, chat.id);
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

test('switching a working chat preserves history, attachments and workspace, stops its runtime and pauses the queue', () =>
  fixture(async (m, root) => {
    const chat = m.newSession('p');
    chat.messages = [
      {
        id: 'u',
        role: 'user',
        text: 'Conserva el diseño',
        attachments: [{ id: 'file', name: 'plan.pdf' }],
        checkpoint: 'old-checkpoint',
      },
      { id: 'a', role: 'assistant', text: 'Usaremos colores neutros.' },
    ];
    chat.attempted = true;
    chat.status = 'working';
    chat.mcpConnectionIds = ['connection'];
    chat.parentId = 'parent';
    chat.worktree = {
      path: root,
      cwd: root,
      root,
      branch: 'feature',
      base: 'main',
      baseCommit: 'abc',
      createdAt: 1,
    };
    chat.pendingInputs = [{ id: 'q', text: 'Siguiente paso', attachments: [], status: 'pending' }];
    let stopped = false;
    m.runtimes.set(chat.id, {
      buffer: '',
      sequence: 0,
      provider: {
        stop: async () => {
          stopped = true;
        },
      } as any,
    });
    const next = await m.changeSessionAccount(chat.id, 'codex');
    assert.equal(stopped, true);
    assert.equal(m.runtimes.has(chat.id), false);
    assert.equal(next.id, chat.id);
    assert.equal(next.messages.length, 2);
    assert.equal(next.messages[0].attachments?.[0].name, 'plan.pdf');
    assert.equal(next.messages[0].checkpoint, undefined);
    assert.equal(next.worktree?.branch, 'feature');
    assert.deepEqual(next.mcpConnectionIds, ['connection']);
    assert.equal(next.parentId, 'parent');
    assert.equal(next.reference, undefined);
    assert.equal(next.attempted, undefined);
    assert.equal(next.info, undefined);
    assert.equal(next.notice, undefined);
    assert.equal(next.pendingInputs?.[0].status, 'failed');
    assert.match(continuationContext(next), /Conserva el diseño/);
    assert.match(continuationContext(next), /colores neutros/);
    const restored = new Store(root).state.sessions[0];
    assert.equal(restored.historyBoundary, 2);
    assert.match(continuationContext(restored), /plan.pdf/);
    const back = await m.changeSessionAccount(next.id, 'claude-1');
    assert.equal(back.messages.length, 2);
    assert.notEqual(back.reference, chat.reference);
    assert.equal(back.attempted, undefined);
  }));

test('failed runtime shutdown does not switch accounts or discard the original conversation', () =>
  fixture(async (m) => {
    const chat = m.newSession('p');
    chat.messages = [{ id: 'u', role: 'user', text: 'Historial protegido' }];
    m.runtimes.set(chat.id, {
      buffer: '',
      sequence: 0,
      provider: {
        stop: async () => {
          throw Error('No se pudo detener');
        },
      } as any,
    });
    await assert.rejects(m.changeSessionAccount(chat.id, 'codex'), /No se pudo detener/);
    assert.equal(m.session(chat.id), chat);
    assert.equal(chat.profile, 'claude-1');
    assert.equal(chat.messages[0].text, 'Historial protegido');
    m.runtimes.delete(chat.id);
  }));

test('Codex resumes only its new thread while retaining the previous account history', () =>
  fixture(async (m) => {
    const chat = m.newSession('p');
    chat.messages = [
      { id: 'u', role: 'user', text: 'Diseño anterior' },
      { id: 'a', role: 'assistant', text: 'Decisión previa' },
    ];
    const next = await m.changeSessionAccount(chat.id, 'codex');
    const calls: any[] = [];
    (m.coordinator as any).config = async () => ({ command: 'fixture', args: [] });
    const runtime = {
      loaded: false,
      buffer: '',
      sequence: 0,
      rpc: {
        call: async (method: string, params: any) => {
          calls.push({ method, params });
          return {
            thread: {
              id: 'new-thread',
              turns:
                method === 'thread/resume'
                  ? [
                      {
                        items: [
                          { type: 'agentMessage', id: 'new-answer', text: 'Respuesta nueva' },
                        ],
                      },
                    ]
                  : [],
            },
          };
        },
      } as any,
    };
    m.runtimes.set(next.id, runtime);
    await m.loadThread(next);
    assert.equal(calls[0].method, 'thread/start');
    assert.match(calls[0].params.developerInstructions, /Decisión previa/);
    runtime.loaded = false;
    await m.loadThread(next);
    assert.equal(calls[1].method, 'thread/resume');
    assert.equal(calls[1].params.threadId, 'new-thread');
    assert.deepEqual(
      next.messages.map((m) => m.id),
      ['u', 'a', 'new-answer'],
    );
    m.runtimes.delete(next.id);
  }));

test('continuation is bounded, excludes tool output and leaves full local history intact', () => {
  const messages = [
    { id: 'u', role: 'user' as const, text: 'x'.repeat(80000) },
    { id: 'a', role: 'assistant' as const, text: 'Última decisión' },
    { id: 't', role: 'tool' as const, text: 'sensitive tool output' },
  ];
  const context = continuationContext({ messages, historyBoundary: 3 });
  assert.ok(context.length < 61000);
  assert.match(context, /Última decisión/);
  assert.doesNotMatch(context, /sensitive tool output/);
  assert.equal(messages[0].text.length, 80000);
});
