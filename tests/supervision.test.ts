import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeOptions, mergeConfig } from '../electron/core';
import { applyClaudeMessage, settle } from '../electron/claude-events';
import {
  attentionBadge,
  cardStatus,
  lastTurnChanges,
  planProgress,
  subagentLine,
} from '../src/supervision';
import type { Session } from '../src/shared';
const session = (extra: Partial<Session> = {}): Session => ({
  id: 's',
  projectId: 'p',
  profile: 'claude-1',
  title: 'S',
  status: 'working',
  messages: [],
  approvals: [],
  ...extra,
});
const system = (subtype: string, fields: Record<string, unknown>) => ({
  type: 'system',
  subtype,
  uuid: 'u',
  session_id: 'x',
  ...fields,
});

test('Claude: las opciones activan resúmenes de subagentes sin sugerencias de prompt', () => {
  const o = claudeOptions(
    { reference: 'uuid', attempted: false, config: mergeConfig() },
    { cwd: '/p', binary: '/bin/claude', profileDir: '/d' },
  ) as any;
  assert.equal(o.agentProgressSummaries, true);
  assert.equal(o.promptSuggestions, false);
});

test('Claude: task_started/progress/notification mantienen la línea de subagentes', () => {
  const s = session();
  applyClaudeMessage(
    s,
    system('task_started', {
      task_id: 'bash',
      description: 'npm run dev',
      task_type: 'local_bash',
    }),
  );
  applyClaudeMessage(
    s,
    system('task_started', {
      task_id: 'ambient',
      description: 'Vigilar',
      task_type: 'local_agent',
      ambient: true,
    }),
  );
  assert.equal(s.subagents, undefined, 'shells and housekeeping tasks are not subagents');
  applyClaudeMessage(
    s,
    system('task_started', {
      task_id: 'a',
      description: 'Revisar rutas',
      task_type: 'local_agent',
      subagent_type: 'Explore',
    }),
  );
  applyClaudeMessage(
    s,
    system('task_started', { task_id: 'b', description: 'Buscar usos', subagent_type: 'Explore' }),
  );
  assert.equal(subagentLine(s), '2 subagentes · Buscar usos');
  applyClaudeMessage(
    s,
    system('task_progress', {
      task_id: 'a',
      description: 'Revisar rutas',
      summary: 'Analizando el módulo de autenticación',
      last_tool_name: 'Grep',
      usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
    }),
  );
  applyClaudeMessage(
    s,
    system('task_progress', { task_id: 'unknown', description: 'x', summary: 'y', usage: {} }),
  );
  assert.deepEqual(s.subagents?.[0], {
    id: 'a',
    description: 'Revisar rutas',
    summary: 'Analizando el módulo de autenticación',
    tool: 'Grep',
  });
  assert.equal(subagentLine(s), '2 subagentes · Analizando el módulo de autenticación');
  applyClaudeMessage(
    s,
    system('task_notification', {
      task_id: 'a',
      status: 'completed',
      output_file: '',
      summary: 'ok',
    }),
  );
  assert.equal(subagentLine(s), 'Subagente · Buscar usos');
  applyClaudeMessage(s, system('task_updated', { task_id: 'b', patch: { status: 'killed' } }));
  assert.equal(s.subagents, undefined);
  assert.equal(subagentLine(s), undefined);
  applyClaudeMessage(
    s,
    system('task_started', { task_id: 'c', description: 'Otro', subagent_type: 'general' }),
  );
  settle(s);
  assert.equal(s.subagents, undefined, 'an interrupted or closed session has no running agents');
});

test('Claude: prompt_suggestion guarda la siguiente petición probable', () => {
  const s = session({ status: 'ready' });
  applyClaudeMessage(s, {
    type: 'prompt_suggestion',
    suggestion: '  Ejecuta los tests  ',
    uuid: 'u',
    session_id: 'x',
  });
  assert.equal(s.suggestion, 'Ejecuta los tests');
  applyClaudeMessage(s, { type: 'prompt_suggestion', suggestion: ' ', uuid: 'u', session_id: 'x' });
  assert.equal(s.suggestion, undefined);
});

test('Supervisión: estado de tarjeta y badge del Dock con los chats que requieren atención', () => {
  const approval = { id: 1, method: 'claude/permission', params: {} };
  const sessions = [
    session({ approvals: [approval], status: 'waiting' }),
    session({ status: 'waiting' }),
    session({ status: 'error', error: 'Falló' }),
    session({ status: 'working' }),
    session({
      status: 'ready',
      messages: [{ id: 'a', role: 'assistant', text: 'Hecho' }],
    }),
    session({ status: 'stopped' }),
  ];
  assert.deepEqual(
    sessions.map((s) => cardStatus(s)[0]),
    ['attention', 'attention', 'error', 'working', 'done', 'idle'],
  );
  assert.equal(attentionBadge(sessions), '3');
  assert.equal(attentionBadge(sessions.slice(3)), '', 'no attention clears the badge');
});

test('Supervisión: progreso del plan mientras sigue siendo relevante', () => {
  const todos = [
    { content: 'Leer', status: 'completed' },
    { content: 'Editar', activeForm: 'Editando', status: 'in_progress' },
    { content: 'Probar', status: 'pending' },
  ];
  assert.deepEqual(planProgress(session({ todos })), { done: 1, total: 3, current: 'Editando' });
  assert.equal(planProgress(session()), undefined);
  const finished = todos.map((t) => ({ ...t, status: 'completed' }));
  assert.deepEqual(planProgress(session({ status: 'ready', todos: finished })), {
    done: 3,
    total: 3,
    current: undefined,
  });
  assert.equal(planProgress(session({ status: 'stopped', todos: finished })), undefined);
  assert.ok(planProgress(session({ status: 'stopped', todos })), 'unfinished plans stay visible');
});

test('Supervisión: archivos cambiados solo del último turno, incluido el que sigue en marcha', () => {
  const edit = (id: string, file: string, done = true) => ({
    type: 'tool_use' as const,
    id,
    name: 'Edit',
    input: { file_path: file, old_string: 'a\nb', new_string: 'a\nc\nd' },
    done,
  });
  const s = session({
    messages: [
      { id: 'u0', role: 'user', text: 'Antes' },
      { id: 'a0', role: 'assistant', text: '', blocks: [edit('e0', '/p/viejo.ts')] },
      { id: 'u1', role: 'user', text: 'Ahora' },
      {
        id: 'a1',
        role: 'assistant',
        text: '',
        blocks: [
          edit('e1', '/p/a.ts'),
          edit('e2', '/p/a.ts'),
          edit('e3', '/p/b.ts', false),
          {
            type: 'tool_use',
            id: 'w',
            name: 'Write',
            input: { file_path: '/p/nuevo.ts', content: 'x\ny\n' },
            done: true,
          },
        ],
      },
      {
        id: 'codex',
        role: 'tool',
        text: '',
        tool: {
          kind: 'edit',
          status: 'completed',
          files: [{ path: '/p/c.ts', kind: 'update', diff: '@@\n-a\n+b\n+c' }],
        },
      },
    ],
  });
  const changes = lastTurnChanges(s)!;
  assert.deepEqual(
    changes.files.map((f) => f.path),
    ['/p/a.ts', '/p/nuevo.ts', '/p/c.ts'],
    'running and earlier-turn edits are not counted',
  );
  assert.equal(changes.added, 4 + 2 + 2);
  assert.equal(changes.removed, 2 + 1);
  assert.equal(
    lastTurnChanges(session({ messages: [{ id: 'u', role: 'user', text: 'Hola' }] })),
    undefined,
  );
});
