import test from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from '../src/shared';
import { attentionItems, attentionPendingCount } from '../src/attention';

const session = (extra: Partial<Session> = {}): Session => ({
  id: 's',
  projectId: 'p',
  profile: 'claude-1',
  title: 'Revisar rutas',
  status: 'ready',
  messages: [],
  approvals: [],
  ...extra,
});
const reply = { id: 'answer', role: 'assistant' as const, text: 'Rutas verificadas.' };

test('attention orders blockers before unread replies without moving same-priority chats', () => {
  const sessions = [
    session({ id: 'done', messages: [reply] }),
    session({ id: 'error', status: 'error', error: 'No se pudo conectar.' }),
    session({
      id: 'codex',
      profile: 'codex',
      approvals: [
        {
          id: 2,
          method: 'item/tool/requestUserInput',
          params: { questions: [{ question: '¿Qué entorno?' }] },
        },
      ],
    }),
    session({
      id: 'claude',
      approvals: [
        {
          id: 3,
          method: 'claude/permission',
          params: {},
          tool: 'Bash',
          input: { command: 'npm test' },
        },
      ],
    }),
  ];
  const items = attentionItems(sessions, { done: 0 });
  assert.deepEqual(
    items.map((item) => item.session.id),
    ['codex', 'claude', 'error', 'done'],
  );
  assert.deepEqual(
    items.map((item) => item.kind),
    ['question', 'permission', 'error', 'completed'],
  );
  assert.equal(items[0].detail, '¿Qué entorno?');
  assert.equal(items[1].detail, 'npm test');
  assert.equal(attentionPendingCount(items), 3);
  assert.deepEqual(
    sessions.map((item) => item.id),
    ['done', 'error', 'codex', 'claude'],
  );
});

test('attention keeps one entry per chat and uses the first actual pending request', () => {
  const s = session({
    status: 'error',
    error: 'Old error',
    approvals: [
      {
        id: 1,
        method: 'claude/permission',
        params: {},
        tool: 'AskUserQuestion',
        input: { questions: [{ question: '¿Azul o verde?' }] },
      },
      { id: 2, method: 'claude/permission', params: {}, tool: 'Bash' },
    ],
  });
  const items = attentionItems([s], {});
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'question');
  assert.equal(items[0].requests, 2);
  assert.equal(items[0].detail, '¿Azul o verde?');
});

test('attention ignores startup history, read responses, streaming work and terminal sessions', () => {
  for (const status of ['working', 'starting', 'stopping', 'terminal'] as const) {
    assert.deepEqual(attentionItems([session({ status, messages: [reply] })], { s: 0 }), []);
  }
  assert.deepEqual(attentionItems([session({ mode: 'terminal', status: 'error' })], {}), []);
  assert.deepEqual(attentionItems([session({ messages: [reply] })], {}), []);
  assert.deepEqual(attentionItems([session({ messages: [reply] })], { s: 1 }), []);
  assert.equal(attentionItems([session({ messages: [reply] })], { s: 0 }).length, 1);
});

test('attention does not mistake old answers, tool results or internal thoughts for a new reply', () => {
  const messages: Session['messages'] = [
    reply,
    { id: 'u', role: 'user', text: 'Ahora verifica login.' },
    { id: 't', role: 'tool', text: 'Done' },
    {
      id: 'thought',
      role: 'assistant',
      text: 'legacy text',
      blocks: [{ type: 'thinking', text: 'thinking' }],
    },
  ];
  assert.deepEqual(attentionItems([session({ messages })], { s: 0 }), []);
  messages.push({
    id: 'a2',
    role: 'assistant',
    text: '',
    blocks: [{ type: 'text', text: 'Login verificado.' }],
  });
  assert.equal(attentionItems([session({ messages })], { s: 3 })[0].detail, 'Login verificado.');
  messages.push({ id: 'a3', role: 'assistant', kind: 'error', text: 'Error' });
  assert.deepEqual(attentionItems([session({ messages })], { s: 5 }), []);
});

test('attention exposes failed outbound messages and clears after a retry succeeds', () => {
  const input = {
    id: 'q',
    text: 'Revisar login',
    attachments: [],
    status: 'failed' as const,
    error: 'Sin conexión',
  };
  const s = session({ pendingInputs: [input], messages: [reply] });
  const failed = attentionItems([s], { s: 0 });
  assert.equal(failed[0].kind, 'delivery');
  assert.equal(failed[0].detail, 'Sin conexión');
  assert.equal(
    attentionItems([{ ...s, pendingInputs: [{ ...input, status: 'sending' }] }], { s: 1 }).length,
    0,
  );
});

test('attention attaches verified changes from the latest turn only', () => {
  const s = session({
    messages: [
      { id: 'u', role: 'user', text: 'Arregla el login' },
      {
        id: 'edit',
        role: 'tool',
        text: '',
        tool: {
          kind: 'edit',
          status: 'completed',
          files: [{ path: '/p/login.ts', kind: 'update', diff: '@@\n-old\n+new\n+test' }],
        },
      },
      reply,
    ],
  });
  const item = attentionItems([s], { s: 1 })[0];
  assert.equal(item.kind, 'completed');
  assert.equal(item.changes?.files[0].path, '/p/login.ts');
  assert.equal(item.changes?.added, 2);
  assert.equal(item.changes?.removed, 1);
});

test('attention waits on explicit runtime state and bounds untrusted descriptions', () => {
  const s = session({ status: 'waiting', activity: 'Esperando\n  una respuesta' });
  assert.equal(attentionItems([s], {})[0].detail, 'Esperando una respuesta');
  const long = session({ status: 'error', error: 'x'.repeat(2000) });
  assert.equal(attentionItems([long], {})[0].detail.length, 220);
  assert.deepEqual(attentionItems([session({ activity: 'conflict', notice: 'error?' })], {}), []);
});

test('attention catches completion in an existing streaming message after leaving the chat', () => {
  const s = session({ messages: [{ id: 'u', role: 'user', text: 'Revisa' }, reply] });
  assert.deepEqual(attentionItems([s], { s: 2 }), []);
  assert.equal(attentionItems([s], { s: 2 }, new Set(['s']))[0].kind, 'completed');
  assert.deepEqual(attentionItems([{ ...s, status: 'working' }], { s: 2 }, new Set(['s'])), []);
  assert.deepEqual(attentionItems([s], { s: 2 }, new Set()), []);
});
