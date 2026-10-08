import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { conversationEntries, currentActivity } from '../src/conversation';
import { ConversationMessages, ActivityDock } from '../src/chat';
import type { Session, Message } from '../src/shared';
const fixture = (): Session => ({
  id: 's',
  projectId: 'p',
  profile: 'claude-1',
  title: 'Stack',
  status: 'ready',
  approvals: [],
  messages: [
    { id: 'u', role: 'user', text: '¿Qué stack utilizas?' },
    {
      id: 'a1',
      role: 'assistant',
      text: '',
      model: 'sonnet',
      blocks: [
        { type: 'thinking', text: 'Revisar archivos', final: true },
        { type: 'text', text: 'Voy a revisar el proyecto.' },
        {
          type: 'tool_use',
          id: 't1',
          name: 'Read',
          input: { file_path: 'package.json' },
          done: true,
          result: '{}',
        },
      ],
    },
    {
      id: 'a2',
      role: 'assistant',
      text: '',
      blocks: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' }, done: true }],
    },
    {
      id: 'a3',
      role: 'assistant',
      text: '',
      blocks: [{ type: 'text', text: 'Usa JavaScript y Node.js.' }],
    },
  ],
});
test('agrupa el trabajo, conserva íntegro el historial y muestra una respuesta sin cabeceras repetidas', () => {
  const session = fixture(),
    original = structuredClone(session);
  const entries = conversationEntries(session);
  assert.equal(entries.length, 2);
  const reply = entries[1];
  assert.equal(reply.type, 'response');
  if (reply.type !== 'response') return;
  assert.equal(reply.answer?.id, 'a3');
  assert.deepEqual(
    reply.work.map((m) => m.id),
    ['a1', 'a2'],
  );
  assert.equal(reply.steps, 2);
  assert.deepEqual(session, original);
  const html = renderToStaticMarkup(
    React.createElement(ConversationMessages, { session, kind: 'claude' }),
  );
  assert.match(html, /Leyó 1 archivo y ejecutó 1 comando/);
  assert.match(html, /Usa JavaScript/);
  assert.doesNotMatch(html, /class="author"/);
});
test('progreso activo en el dock; no oculta una respuesta terminada durante arranque o parada', () => {
  const session = fixture();
  session.status = 'working';
  assert.equal(currentActivity(session)?.pending, true);
  assert.equal(currentActivity(session)?.answer, undefined);
  const html = renderToStaticMarkup(React.createElement(ActivityDock, { session, kind: 'claude' }));
  assert.match(html, /activity-current/);
  assert.match(html, /Usa JavaScript/);
  for (const status of ['ready', 'stopped', 'starting', 'stopping', 'error'] as const) {
    session.status = status;
    assert.equal(currentActivity(session), undefined);
    const tail = conversationEntries(session).at(-1)!;
    assert.equal(tail.type === 'response' && tail.answer?.id, 'a3');
  }
});
test('texto antes de herramientas y después de herramientas del mismo mensaje se separa sin pérdidas', () => {
  const session = fixture();
  session.messages = [
    session.messages[0],
    {
      id: 'a',
      role: 'assistant',
      text: '',
      blocks: [
        { type: 'text', text: 'Consultando…' },
        { type: 'tool_use', id: 't', name: 'Read', input: {}, done: true, isError: true },
        { type: 'text', text: 'No se pudo leer el archivo.' },
      ],
    },
  ];
  const tail = conversationEntries(session).at(-1)!;
  assert.equal(tail.type, 'response');
  if (tail.type !== 'response') return;
  assert.deepEqual(tail.answer?.blocks, [{ type: 'text', text: 'No se pudo leer el archivo.' }]);
  assert.equal(tail.work[0].blocks?.length, 2);
  assert.equal(tail.errors, 1);
  session.messages[1].blocks!.pop();
  const interrupted = conversationEntries(session).at(-1)!;
  assert.equal(interrupted.type === 'response' && interrupted.answer, undefined);
});
test('Codex, avisos de error, adjuntos y varios turnos mantienen orden y datos', () => {
  const session = fixture();
  session.profile = 'codex';
  const messages: Message[] = [
    {
      id: 'u',
      role: 'user',
      text: 'Lee el archivo',
      attachments: [{ id: 'img', name: 'Imagen', preview: 'data:image/png;base64,' }],
    },
    { id: 'a', role: 'assistant', text: 'Voy a leerlo.' },
    { id: 't', role: 'tool', text: '$ cat file\ncontenido' },
    { id: 'r', role: 'assistant', text: 'Resultado final.' },
    { id: 'e', role: 'system', kind: 'error', text: 'Error visible' },
    { id: 'u2', role: 'user', text: 'Continúa' },
  ];
  session.messages = messages;
  session.status = 'working';
  const entries = conversationEntries(session);
  assert.deepEqual(
    entries.map((e) => e.id),
    ['u', 'a', 'e', 'u2'],
  );
  assert.equal(entries[1].type === 'response' && entries[1].answer?.text, 'Resultado final.');
  assert.equal(currentActivity(session), undefined);
  assert.deepEqual(session.messages, messages);
});
test('espera de permisos se anuncia y los errores de herramientas siguen señalados', () => {
  const session = fixture();
  session.status = 'waiting';
  session.approvals = [{ id: 'p', method: 'claude/permission', params: {} }];
  const tool = session.messages[2].blocks![0];
  if (tool.type === 'tool_use') tool.isError = true;
  const html = renderToStaticMarkup(React.createElement(ActivityDock, { session, kind: 'claude' }));
  assert.match(html, /Esperando tu respuesta/);
  assert.match(html, /1 error/);
  assert.equal(session.approvals.length, 1);
});
