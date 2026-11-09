import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { turnPlan, hasPlanTools } from '../src/turn-plan';
import { ConversationMessages } from '../src/chat';
import type { Message, Session } from '../src/shared';

const tool = (name: string, input: unknown, extra: Record<string, unknown> = {}): Message => ({
  id: `${name}-${Math.random()}`,
  role: 'assistant',
  text: '',
  blocks: [{ type: 'tool_use', id: `t-${Math.random()}`, name, input, done: true, ...extra }],
});

test('TodoWrite reemplaza el plan y conserva estados y forma activa', () => {
  const plan = turnPlan([
    tool('TodoWrite', { todos: [{ content: 'A', status: 'pending' }] }),
    tool('TodoWrite', {
      todos: [
        { content: 'A', status: 'completed' },
        { content: 'B', status: 'in_progress', activeForm: 'Haciendo B' },
        { content: '', status: 'pending' },
      ],
    }),
  ]);
  assert.deepEqual(plan, [
    { content: 'A', status: 'completed', activeForm: undefined },
    { content: 'B', status: 'in_progress', activeForm: 'Haciendo B' },
  ]);
});

test('TaskCreate y TaskUpdate se reproducen por id; errores y turnos sin plan se ignoran', () => {
  const messages = [
    tool('TaskCreate', { subject: 'Revisar' }, { result: 'Task #1 created' }),
    tool('TaskCreate', { subject: 'Proponer' }, { result: '{"task":{"id":"2"}}' }),
    tool('TaskUpdate', { taskId: '1', status: 'completed' }),
    tool('TaskUpdate', { taskId: '2', status: 'in_progress' }, { isError: true }),
  ];
  assert.equal(hasPlanTools(messages), true);
  assert.deepEqual(
    turnPlan(messages)?.map((t) => `${t.id}:${t.status}`),
    ['1:completed', '2:pending'],
  );
  assert.equal(turnPlan([tool('Read', { file_path: 'a' })]), undefined);
  assert.equal(hasPlanTools([tool('Read', { file_path: 'a' })]), false);
});

test('la respuesta muestra su plan como tarjeta antes del trabajo', () => {
  const session: Session = {
    id: 's',
    projectId: 'p',
    profile: 'claude-1',
    title: 'Plan',
    status: 'working',
    approvals: [],
    todos: [
      { content: 'Revisar marcas', status: 'completed' },
      { content: 'Buscar keywords', status: 'in_progress', activeForm: 'Buscando keywords' },
      { content: 'Proponer temas', status: 'pending' },
    ],
    messages: [
      { id: 'u', role: 'user', text: 'Busca temas para enero' },
      tool('TodoWrite', { todos: [{ content: 'Revisar marcas', status: 'pending' }] }),
    ],
  };
  const html = renderToStaticMarkup(
    React.createElement(ConversationMessages, { session, kind: 'claude' }),
  );
  assert.match(html, /class="turn-plan live"/);
  assert.match(html, /Buscando keywords/);
  assert.match(html, /plan-mark completed/);
  assert.ok(html.indexOf('turn-plan') < html.indexOf('response-work'));
  // A finished turn keeps its plan with the final wording.
  session.status = 'ready';
  const done = renderToStaticMarkup(
    React.createElement(ConversationMessages, { session, kind: 'claude' }),
  );
  assert.match(done, /class="turn-plan "/);
  assert.match(done, />Buscar keywords</);
});
