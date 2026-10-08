import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyCodexEvent, messageFromItem } from '../electron/codex-events';
import { applyClaudeMessage } from '../electron/claude-events';
import { Store } from '../electron/store';
import type { Session } from '../src/shared';
const session = (profile: Session['profile']): Session => ({
  id: 's',
  projectId: 'p',
  profile,
  title: 'S',
  reference: 'thread',
  status: 'ready',
  messages: [],
  approvals: [],
});
const event = (s: Session, method: string, params: any) =>
  applyCodexEvent(s, method, { threadId: 'thread', ...params });

test('Codex: comandos estructurados con salida en streaming, código de salida y duración', () => {
  const s = session('codex');
  event(s, 'turn/started', { turn: { id: 't' } });
  event(s, 'item/started', {
    item: {
      type: 'commandExecution',
      id: 'c',
      command: 'cat a.ts',
      status: 'inProgress',
      commandActions: [{ type: 'read', command: 'cat a.ts', name: 'a.ts', path: '/p/a.ts' }],
      aggregatedOutput: null,
    },
  });
  event(s, 'item/commandExecution/outputDelta', { itemId: 'c', delta: 'hola ' });
  event(s, 'item/commandExecution/outputDelta', { itemId: 'c', delta: 'mundo' });
  const m = s.messages[0];
  assert.equal(m.text, '$ cat a.ts');
  assert.equal(m.tool?.output, 'hola mundo');
  assert.deepEqual(m.tool?.actions, [{ type: 'read', path: '/p/a.ts', query: undefined }]);
  event(s, 'item/completed', {
    item: {
      type: 'commandExecution',
      id: 'c',
      command: 'cat a.ts',
      status: 'completed',
      aggregatedOutput: 'x'.repeat(40000),
      exitCode: 0,
      durationMs: 1200,
    },
  });
  assert.equal(s.messages.length, 1);
  assert.equal(m.tool?.exitCode, 0);
  assert.equal(m.tool?.durationMs, 1200);
  assert.ok(m.tool!.output!.length <= 30001 && m.tool!.output!.startsWith('…'));
});
test('Codex: cambios de archivos, razonamiento, plan y duración del turno', () => {
  const s = session('codex');
  event(s, 'turn/started', { turn: { id: 't' } });
  const change = messageFromItem({
    type: 'fileChange',
    id: 'f',
    status: 'completed',
    changes: [{ path: '/p/a.ts', kind: { type: 'update', move_path: null }, diff: '@@\n-a\n+b' }],
  });
  assert.deepEqual(change?.tool?.files, [{ path: '/p/a.ts', kind: 'update', diff: '@@\n-a\n+b' }]);
  event(s, 'item/started', { item: { type: 'reasoning', id: 'r', summary: [], content: [] } });
  event(s, 'item/reasoning/summaryTextDelta', { itemId: 'r', delta: 'Primero', summaryIndex: 0 });
  event(s, 'item/reasoning/summaryPartAdded', { itemId: 'r', summaryIndex: 1 });
  event(s, 'item/reasoning/summaryTextDelta', { itemId: 'r', delta: 'Después', summaryIndex: 1 });
  assert.deepEqual(s.messages[0].blocks, [
    { type: 'thinking', text: 'Primero\n\nDespués', final: false },
  ]);
  event(s, 'item/completed', { item: { type: 'reasoning', id: 'r', summary: [], content: [] } });
  assert.deepEqual(s.messages[0].blocks, [
    { type: 'thinking', text: 'Primero\n\nDespués', final: true },
  ]);
  event(s, 'turn/plan/updated', {
    turnId: 't',
    plan: [
      { step: 'Leer', status: 'completed' },
      { step: 'Editar', status: 'inProgress' },
      { step: 'Probar', status: 'pending' },
    ],
  });
  assert.deepEqual(
    s.todos?.map((t) => t.status),
    ['completed', 'in_progress', 'pending'],
  );
  event(s, 'item/completed', { item: { type: 'agentMessage', id: 'm', text: 'Hecho.' } });
  event(s, 'turn/completed', {
    turn: { id: 't', status: 'completed', startedAt: 100, completedAt: 112, durationMs: null },
  });
  assert.equal(s.messages.at(-1)?.durationMs, 12000);
  assert.equal(s.status, 'ready');
});
test('Claude: duración del turno y tiempo de cada herramienta', () => {
  const s = session('claude-1');
  applyClaudeMessage(s, {
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'message_start', message: { id: 'a', model: 'claude-x' } },
  });
  applyClaudeMessage(s, {
    type: 'stream_event',
    parent_tool_use_id: null,
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 't', name: 'Bash', input: {} },
    },
  });
  const block = s.messages[0].blocks![0] as any;
  assert.equal(typeof block.at, 'number');
  block.at -= 1500;
  applyClaudeMessage(s, {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
  });
  assert.ok(block.ms >= 1500 && block.ms < 5000);
  applyClaudeMessage(s, {
    type: 'result',
    subtype: 'success',
    duration_ms: 4321,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  assert.equal(s.messages[0].durationMs, 4321);
});
test('la persistencia conserva duraciones y herramientas estructuradas', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desk-events-'));
  try {
    const store = new Store(dir);
    store.state.profiles = [{ id: 'codex', name: 'Codex', kind: 'codex' }];
    store.state.projects = [{ id: 'p', name: 'P', path: '/tmp/p' }];
    store.state.sessions = [
      {
        ...session('codex'),
        messages: [
          { id: 'a', role: 'assistant', text: 'Hecho', durationMs: 900 },
          {
            id: 'c',
            role: 'tool',
            text: '$ ls',
            tool: { kind: 'command', command: 'ls', status: 'completed', exitCode: 0 },
          },
          {
            id: 'b',
            role: 'assistant',
            text: '',
            blocks: [
              { type: 'tool_use', id: 't', name: 'Bash', input: {}, done: true, ms: 77, at: 1 },
            ],
          },
        ],
      },
    ];
    store.flush();
    const restored = new Store(dir).state.sessions[0].messages;
    assert.equal(restored[0].durationMs, 900);
    assert.deepEqual(restored[1].tool, {
      kind: 'command',
      command: 'ls',
      status: 'completed',
      exitCode: 0,
    });
    assert.equal((restored[2].blocks![0] as any).ms, 77);
    assert.equal((restored[2].blocks![0] as any).at, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
