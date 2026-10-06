import test from 'node:test';
import assert from 'node:assert/strict';
import { actionSchema, claudeOptions, mergeConfig, permissionResult } from '../electron/core';
import { applyClaudeMessage } from '../electron/claude-events';
import type { Session } from '../src/shared';
const session = (): Session => ({
  id: 's',
  projectId: 'p',
  profile: 'claude-1',
  title: 'Sesión 1',
  reference: 'uuid',
  status: 'working',
  messages: [],
  approvals: [],
  config: mergeConfig(),
});
test('la configuración de la interfaz se traduce a opciones del SDK sin fugas', () => {
  const o = claudeOptions(
    {
      reference: 'uuid',
      attempted: false,
      config: mergeConfig({ model: 'opus', effort: 'high', maxTurns: 5 }),
    },
    {
      cwd: '/proj',
      binary: '/bin/claude',
      profileDir: '/data/profiles/claude-1',
      env: { HOME: '/h', PATH: '/bin', ANTHROPIC_API_KEY: 'x', CLAUDE_CONFIG_DIR: '/global' },
    },
  ) as any;
  assert.equal(o.sessionId, 'uuid');
  assert.equal(o.resume, undefined);
  assert.equal(o.model, 'opus');
  assert.equal(o.effort, 'high');
  assert.equal(o.maxTurns, 5);
  assert.equal(o.env.CLAUDE_CONFIG_DIR, '/data/profiles/claude-1');
  assert.equal(o.env.ANTHROPIC_API_KEY, undefined);
  assert.deepEqual(o.settingSources, ['user']);
  assert.deepEqual(o.settings, { forceLoginMethod: 'claudeai' });
  assert.equal(o.allowDangerouslySkipPermissions, undefined);
  assert.equal(o.systemPrompt, undefined);
  const resumed = claudeOptions(
    {
      reference: 'uuid',
      attempted: true,
      config: mergeConfig({
        model: 'default',
        permissionMode: 'bypassPermissions',
        appendSystemPrompt: 'Responde en catalán',
      }),
    },
    { cwd: '/proj', binary: '/bin/claude', profileDir: '/d' },
  ) as any;
  assert.equal(resumed.resume, 'uuid');
  assert.equal(resumed.model, undefined);
  assert.equal(resumed.allowDangerouslySkipPermissions, true);
  assert.deepEqual(resumed.systemPrompt, {
    type: 'preset',
    preset: 'claude_code',
    append: 'Responde en catalán',
  });
  assert.equal(
    actionSchema.safeParse({
      type: 'configure',
      sessionId: 's',
      config: { permissionMode: 'root' },
    }).success,
    false,
  );
  assert.equal(
    actionSchema.safeParse({ type: 'configure', sessionId: 's', config: { maxBudgetUsd: 2 } })
      .success,
    true,
  );
});
test('respuestas de permiso: una vez, siempre, rechazo, preguntas y plan', () => {
  const bash = {
    tool: 'Bash',
    input: { command: 'npm test' },
    suggestions: [
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
        behavior: 'allow',
        destination: 'localSettings',
      },
    ],
  };
  assert.deepEqual(permissionResult(bash, 'accept'), {
    behavior: 'allow',
    updatedInput: bash.input,
  });
  assert.deepEqual((permissionResult(bash, 'always') as any).updatedPermissions, bash.suggestions);
  assert.deepEqual(
    (permissionResult({ tool: 'Read', input: {} }, 'always') as any).updatedPermissions,
    [
      {
        type: 'addRules',
        rules: [{ toolName: 'Read' }],
        behavior: 'allow',
        destination: 'session',
      },
    ],
  );
  assert.deepEqual(permissionResult(bash, 'decline', undefined, 'usa pnpm'), {
    behavior: 'deny',
    message: 'usa pnpm',
  });
  const ask = {
    tool: 'AskUserQuestion',
    input: { questions: [{ question: '¿Framework?', options: [] }] },
  };
  assert.throws(() => permissionResult(ask, 'accept', {}));
  assert.deepEqual(permissionResult(ask, 'accept', { '¿Framework?': 'React' }), {
    behavior: 'allow',
    updatedInput: { questions: ask.input.questions, answers: { '¿Framework?': 'React' } },
  });
  assert.deepEqual(
    (permissionResult({ tool: 'ExitPlanMode', input: {} }, 'always') as any).updatedPermissions,
    [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
  );
});
test('el reductor reconstruye streaming, herramientas, resultados y estado sin duplicar', () => {
  const s = session();
  const sid = 'sess';
  applyClaudeMessage(s, {
    type: 'system',
    subtype: 'init',
    model: 'claude-x',
    tools: ['Bash', 'Read'],
    mcp_servers: [],
    slash_commands: ['compact'],
    claude_code_version: '2.1',
    permissionMode: 'default',
    session_id: sid,
  });
  assert.equal(s.info?.model, 'claude-x');
  assert.equal(s.reference, sid);
  const ev = (event: any) =>
    applyClaudeMessage(s, { type: 'stream_event', event, parent_tool_use_id: null });
  ev({ type: 'message_start', message: { id: 'm1', model: 'claude-x' } });
  ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
  ev({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'pienso' },
  });
  applyClaudeMessage(s, {
    type: 'assistant',
    message: { id: 'm1', content: [{ type: 'thinking', thinking: 'pienso bien' }] },
    parent_tool_use_id: null,
  });
  ev({
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
  });
  ev({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"command": "ls' },
  });
  ev({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '"}' },
  });
  assert.deepEqual((s.messages[0].blocks![1] as any).input, { command: 'ls' });
  applyClaudeMessage(s, {
    type: 'assistant',
    message: {
      id: 'm1',
      content: [
        {
          type: 'tool_use',
          id: 't1',
          name: 'Bash',
          input: { command: 'ls', description: 'lista' },
        },
      ],
    },
    parent_tool_use_id: null,
  });
  applyClaudeMessage(s, {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt', is_error: false }],
    },
    parent_tool_use_id: null,
  });
  ev({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } });
  ev({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Hay ' } });
  ev({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'un archivo.' } });
  applyClaudeMessage(s, {
    type: 'assistant',
    message: { id: 'm1', content: [{ type: 'text', text: 'Hay un archivo.' }] },
    parent_tool_use_id: null,
  });
  // A sub-agent message nests under its Task tool without creating a top-level message.
  applyClaudeMessage(s, {
    type: 'assistant',
    message: {
      id: 'm1',
      content: [{ type: 'tool_use', id: 't2', name: 'Task', input: { description: 'explora' } }],
    },
    parent_tool_use_id: null,
  });
  applyClaudeMessage(s, {
    type: 'assistant',
    message: {
      id: 'sub',
      content: [{ type: 'tool_use', id: 't3', name: 'Read', input: { file_path: '/x' } }],
    },
    parent_tool_use_id: 't2',
  });
  applyClaudeMessage(s, {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't3', content: 'contenido' }],
    },
    parent_tool_use_id: 't2',
  });
  applyClaudeMessage(s, {
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0.05,
    duration_ms: 1200,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 0,
    },
    num_turns: 3,
  });
  assert.equal(s.messages.length, 1);
  const blocks = s.messages[0].blocks!;
  assert.equal(blocks.length, 4);
  assert.deepEqual(blocks[0], { type: 'thinking', text: 'pienso bien', final: true });
  assert.equal((blocks[1] as any).result, 'a.txt');
  assert.equal((blocks[1] as any).done, true);
  assert.deepEqual(blocks[2], { type: 'text', text: 'Hay un archivo.', final: true });
  assert.equal((blocks[3] as any).children[0].result, 'contenido');
  assert.equal(s.status, 'ready');
  assert.equal(s.attempted, true);
  assert.equal(s.stats?.cost, 0.05);
  assert.equal(s.stats?.inputTokens, 15);
  // Replays from a resumed session are ignored; local history is the source of truth.
  applyClaudeMessage(s, {
    type: 'user',
    isReplay: true,
    message: { role: 'user', content: 'hola' },
    parent_tool_use_id: null,
  });
  assert.equal(s.messages.length, 1);
  applyClaudeMessage(s, {
    type: 'assistant',
    message: { id: 'm2', content: [{ type: 'text', text: 'Sin sesión' }] },
    error: 'authentication_failed',
    parent_tool_use_id: null,
  });
  assert.match(s.error ?? '', /login/);
  applyClaudeMessage(s, {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'auto', pre_tokens: 150000, post_tokens: 20000 },
  });
  assert.equal(s.messages.at(-1)?.kind, 'compact');
  applyClaudeMessage(s, {
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.5 } } },
  });
  assert.equal(s.rateLimit?.fiveHour, 0.5);
  applyClaudeMessage(s, {
    type: 'assistant',
    message: {
      id: 'm3',
      content: [
        {
          type: 'tool_use',
          id: 't9',
          name: 'TodoWrite',
          input: { todos: [{ content: 'a', status: 'pending', activeForm: 'a' }] },
        },
      ],
    },
    parent_tool_use_id: null,
  });
  assert.equal(s.todos?.length, 1);
});
