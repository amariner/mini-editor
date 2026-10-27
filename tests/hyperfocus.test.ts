import test from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from '../src/shared';
import { hyperfocusTurn } from '../src/hyperfocus-state';

const fixture = (): Session => ({
  id: 's',
  projectId: 'p',
  profile: 'claude-1',
  title: 'Focus',
  status: 'ready',
  approvals: [],
  messages: [
    { id: 'u0', role: 'user', text: 'Pregunta anterior' },
    { id: 'a0', role: 'assistant', text: 'Respuesta anterior' },
    {
      id: 'u1',
      role: 'user',
      text: 'Pregunta actual',
      attachments: [{ id: 'file', name: 'nota.txt' }],
    },
    {
      id: 'a1',
      role: 'assistant',
      text: '',
      blocks: [
        { type: 'thinking', text: 'Razonamiento privado' },
        { type: 'text', text: 'Voy a revisar el archivo.' },
        { type: 'tool_use', id: 't', name: 'Read', input: {}, done: true, result: 'Contenido' },
        { type: 'text', text: 'Respuesta directa.' },
      ],
    },
  ],
});
test('focus shows only the latest user and final answer, without changing history or attachments', () => {
  const session = fixture(),
    original = structuredClone(session);
  const turn = hyperfocusTurn(session);
  assert.equal(turn.user?.text, 'Pregunta actual');
  assert.equal(turn.user?.attachments?.[0].id, 'file');
  assert.equal(turn.answer, 'Respuesta directa.');
  assert.deepEqual(session, original);
});
test('work in progress and approvals never masquerade as the final answer', () => {
  for (const status of ['starting', 'working', 'waiting', 'stopping'] as const) {
    const session = fixture();
    session.status = status;
    assert.equal(hyperfocusTurn(session).answer, '');
  }
  const session = fixture();
  session.approvals = [{ id: 'approval', method: 'claude/permission', params: {} }];
  assert.equal(hyperfocusTurn(session).answer, '');
});
test('a new user message clears the previous answer; system notes and tools stay hidden', () => {
  const session = fixture();
  session.messages.push({ id: 'u2', role: 'user', text: 'Otra pregunta' });
  session.messages.push({ id: 'note', role: 'system', text: 'Coste: 1' });
  session.messages.push({ id: 'tool', role: 'tool', text: 'Salida del comando' });
  const turn = hyperfocusTurn(session);
  assert.equal(turn.user?.id, 'u2');
  assert.equal(turn.answer, '');
  session.messages.push({ id: 'answer', role: 'assistant', text: 'La nueva respuesta' });
  assert.equal(hyperfocusTurn(session).answer, 'La nueva respuesta');
});
test('empty chats have no artificial content or watermark', () => {
  const session = fixture();
  session.messages = [];
  assert.deepEqual(hyperfocusTurn(session), { user: undefined, pending: false, answer: '' });
});
