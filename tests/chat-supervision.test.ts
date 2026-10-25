import test from 'node:test';
import assert from 'node:assert/strict';
import { actionSchema, claudeOptions, codexParams, mergeConfig } from '../electron/core';
import { applyClaudeMessage } from '../electron/claude-events';
import { applyCodexEvent } from '../electron/codex-events';
import type { Session } from '../src/shared';
const session = (): Session => ({
  id: 's',
  projectId: 'p',
  profile: 'claude-1',
  title: 'Chat',
  status: 'working',
  messages: [],
  approvals: [],
});
function tool(
  s: Session,
  id: string,
  name: string,
  input: unknown,
  result: string,
  error = false,
  parent?: string,
) {
  applyClaudeMessage(s, {
    type: 'assistant',
    parent_tool_use_id: parent,
    message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name, input }] },
  });
  applyClaudeMessage(s, {
    type: 'user',
    parent_tool_use_id: parent,
    message: {
      content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: error }],
    },
  });
}
test('fast mode is session scoped, validated, and explicitly reversible', () => {
  for (const fastMode of [true, false]) {
    for (const type of ['configure', 'configureCodex'])
      assert.equal(
        actionSchema.safeParse({ type, sessionId: 's', config: { fastMode } }).success,
        true,
      );
    const codex = codexParams({ fastMode }, '/project');
    assert.equal(codex.turn.serviceTier, fastMode ? 'fast' : 'default');
    const claude = claudeOptions(
      { config: mergeConfig({ fastMode }) },
      { cwd: '/project', binary: '/claude', profileDir: '/profile' },
    );
    assert.equal((claude.settings as any).fastMode, fastMode);
  }
  assert.equal(codexParams(undefined, '/p').turn.serviceTier, undefined);
  assert.equal(
    actionSchema.safeParse({ type: 'configure', sessionId: 's', config: { fastMode: 'true' } })
      .success,
    false,
  );
});
test('Claude task results create, update, deduplicate and delete the parent plan', () => {
  const s = session();
  tool(
    s,
    'create',
    'TaskCreate',
    { subject: 'Revisar', activeForm: 'Revisando' },
    'Task #1 created successfully: Revisar',
  );
  tool(s, 'duplicate', 'TaskCreate', { subject: 'Revisar' }, '{"task":{"id":"1"}}');
  assert.equal(s.todos?.length, 1);
  tool(s, 'start', 'TaskUpdate', { taskId: '1', status: 'in_progress' }, 'Updated task #1');
  assert.equal(s.todos?.[0].status, 'in_progress');
  tool(s, 'failed', 'TaskUpdate', { taskId: '1', status: 'completed' }, 'Error', true);
  assert.equal(s.todos?.[0].status, 'in_progress');
  tool(s, 'finish', 'TaskUpdate', { taskId: '1', status: 'completed' }, 'Updated task #1');
  assert.equal(s.todos?.[0].status, 'completed');
  tool(s, 'remove', 'TaskUpdate', { taskId: '1', status: 'deleted' }, 'Deleted task #1');
  assert.equal(s.todos?.length, 0);
});
test('subagent todos never replace the parent plan', () => {
  const s = session();
  s.todos = [{ content: 'Principal', status: 'in_progress' }];
  tool(s, 'agent', 'Agent', {}, '');
  tool(
    s,
    'nested',
    'TodoWrite',
    { todos: [{ content: 'Hijo', status: 'pending' }] },
    '',
    false,
    'agent',
  );
  assert.equal(s.todos[0].content, 'Principal');
});
test('Codex context uses latest window occupancy rather than accumulated usage', () => {
  const s = session();
  s.reference = 'thread';
  applyCodexEvent(s, 'thread/tokenUsage/updated', {
    threadId: 'thread',
    tokenUsage: {
      total: { inputTokens: 900000, outputTokens: 40000 },
      last: { totalTokens: 25000 },
      modelContextWindow: 100000,
    },
  });
  assert.equal(s.stats?.contextPercent, 25);
  assert.equal(s.stats?.inputTokens, 900000);
  applyCodexEvent(s, 'thread/tokenUsage/updated', {
    threadId: 'thread',
    tokenUsage: {
      total: { inputTokens: 900001, outputTokens: 40000 },
      last: { totalTokens: -1 },
      modelContextWindow: 0,
    },
  });
  assert.equal(s.stats?.contextPercent, 25);
});
