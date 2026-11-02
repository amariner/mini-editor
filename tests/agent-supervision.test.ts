import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Session, Snapshot } from '../src/shared';
import {
  observeSession,
  finishSession,
  markSessionRead,
  hasUnreadTurn,
} from '../src/session-supervision';
import { cardStatus } from '../src/supervision';
import { applyClaudeMessage } from '../electron/claude-events';
import { permissionResult, claudeOptions, mergeConfig } from '../electron/core';
import { Store } from '../electron/store';
import { PendingInputs } from '../electron/pending-inputs';
import { Teams } from '../electron/teams';
import { fetchCodexModels } from '../electron/codex-models';
import { searchDesk } from '../src/commands';

const chat = (id = 's'): Session => ({
  id,
  title: id,
  projectId: 'p',
  profile: 'claude-1',
  status: 'ready',
  messages: [],
  approvals: [],
});
test('a permission wait stays in the same revision; interruption is never rewritten as success', () => {
  const s = chat();
  s.status = 'working';
  observeSession(s, 'ready', 100);
  s.status = 'waiting';
  observeSession(s, 'working', 110);
  s.status = 'working';
  observeSession(s, 'waiting', 120);
  assert.equal(s.supervision?.revision, 1);
  finishSession(s, 'interrupted', 130);
  applyClaudeMessage(s, { type: 'result', subtype: 'success' });
  observeSession(s, 'working', 140);
  assert.equal(cardStatus(s)[1], 'Interrumpido');
  s.status = 'working';
  observeSession(s, 'ready', 150);
  assert.equal(s.supervision?.revision, 2);
  assert.equal(s.supervision?.outcome, undefined);
});
test('read acknowledgements are shared, monotonic, and cannot acknowledge future or earlier turns', () => {
  const s = chat();
  s.status = 'working';
  observeSession(s, 'ready', 100);
  finishSession(s, 'completed', 200);
  s.status = 'ready';
  assert.equal(hasUnreadTurn(s), true);
  assert.equal(markSessionRead(s, 2), false);
  assert.equal(markSessionRead(s, 1), true);
  assert.equal(hasUnreadTurn(s), false);
  s.status = 'working';
  observeSession(s, 'ready', 300);
  finishSession(s, 'completed', 400);
  assert.equal(markSessionRead(s, 1), false);
  assert.equal(hasUnreadTurn(s), true);
});
test('subagent completions retain one delivery even when both lifecycle notifications arrive', () => {
  const s = chat();
  applyClaudeMessage(s, {
    type: 'system',
    subtype: 'task_started',
    task_id: 'a',
    task_type: 'local_agent',
    description: 'Revisar',
  });
  applyClaudeMessage(s, {
    type: 'system',
    subtype: 'task_updated',
    task_id: 'a',
    patch: { status: 'completed' },
  });
  applyClaudeMessage(s, {
    type: 'task_notification',
    task_id: 'a',
    status: 'completed',
    summary: 'Dos problemas encontrados',
  });
  assert.equal(s.agentDeliveries?.length, 1);
  assert.equal(s.agentDeliveries?.[0].summary, 'Dos problemas encontrados');
  assert.equal(s.agentDeliveries?.[0].outcome, 'completed');
  assert.equal(s.subagents, undefined);
});
test('supervision, read positions and deliveries survive storage; unfinished work recovers as interrupted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-supervision-'));
  try {
    const store = new Store(root);
    const s = chat();
    s.status = 'working';
    observeSession(s, 'ready', 100);
    s.agentDeliveries = [{ id: 'a', description: 'Prueba', outcome: 'completed', finishedAt: 90 }];
    store.state.profiles = [{ id: 'claude-1', kind: 'claude', name: 'Cuenta' }];
    store.state.sessions = [s];
    store.flush();
    const restored = new Store(root).state.sessions[0];
    assert.equal(restored.supervision?.outcome, 'interrupted');
    assert.equal(restored.agentDeliveries?.[0].id, 'a');
    assert.equal(restored.status, 'stopped');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('paused host input retains attachments and only delivers after explicit resume', async () => {
  const s = chat();
  let sent: unknown[] = [];
  const file = { attachment: { id: 'attachment', name: 'a.png' } } as any;
  const pending = new PendingInputs({
    sessions: () => [s],
    ready: () => true,
    send: async (_id, _text, files) => {
      sent = files;
    },
    changed: () => {},
  });
  pending.enqueue(s, 'Revisar imagen', [file]);
  s.deliveryPaused = true;
  pending.pump();
  assert.equal(s.pendingInputs?.[0].status, 'pending');
  assert.equal(sent.length, 0);
  s.deliveryPaused = false;
  pending.pump();
  await new Promise((r) => setImmediate(r));
  assert.equal(sent[0], file);
  assert.equal(s.pendingInputs?.length, 0);
});
test('team messages that arrive after interruption remain queued until resumed', async () => {
  const root = chat('root'),
    child = { ...chat('child'), parentId: 'root', deliveryPaused: true };
  let delivered = 0;
  const teams = new Teams({
    sessions: () => [root, child],
    projects: () => [],
    create: () => child,
    changed: () => {},
    send: async () => {
      delivered++;
    },
  });
  teams.call('root', {
    operation: 'send',
    targetId: 'child',
    text: 'Entrega posterior a la interrupción',
  });
  teams.pump();
  assert.equal(delivered, 0);
  assert.equal(child.teamMessages?.[0].status, 'queued');
  child.deliveryPaused = false;
  teams.pump();
  await new Promise((r) => setImmediate(r));
  assert.equal(delivered, 1);
});
test('partial questions require the negotiated capability and explain omissions to the model', () => {
  const approval = {
    tool: 'AskUserQuestion',
    input: { questions: [{ question: 'A' }, { question: 'B' }] },
  };
  assert.throws(
    () => permissionResult(approval, 'accept', { A: 'Sí' }, undefined, { B: 'skipped' }),
    /todas/,
  );
  const result = permissionResult(
    approval,
    'accept',
    { A: 'Sí' },
    undefined,
    { B: 'skipped' },
    true,
  ) as any;
  assert.equal(result.updatedInput.annotations.B.unanswered, 'skipped');
  assert.match(result.updatedInput.answers.B, /omitido/);
  assert.equal(result.updatedInput.answers.A, 'Sí');
});
test('subagent effort is explicit and does not inherit arbitrary environment variables', () => {
  const o = claudeOptions(
    { config: mergeConfig({ subagentEffort: 'low' }) },
    { cwd: '/p', profileDir: '/d', binary: '/bin/claude', env: { ANTHROPIC_API_KEY: 'secret' } },
  ) as any;
  assert.equal(o.env.CLAUDE_CODE_SUBAGENT_EFFORT, 'low');
  assert.equal(o.env.ANTHROPIC_API_KEY, undefined);
});
test('model catalogs retain text-only capabilities and tolerate older catalogs', async () => {
  const models = await fetchCodexModels(async () => ({
    data: [{ model: 'text', inputModalities: ['text'] }, { model: 'legacy' }],
  }));
  assert.equal(models[0].image, false);
  assert.equal(models[1].image, true);
});
test('command discovery only offers operations available in the current context', () => {
  const state: Snapshot = { projects: [], sessions: [], tools: {}, dataDir: '/tmp' };
  assert.equal(searchDesk(state, '>interrumpir', {}).length, 0);
  assert.equal(searchDesk(state, '>nuevo', {}).length, 0);
  assert.equal(searchDesk(state, '>atención', {})[0].command, 'attention');
  const s = chat();
  s.status = 'working';
  state.sessions = [s];
  state.selectedSession = s.id;
  state.selectedProject = 'p';
  assert.equal(searchDesk(state, '>interrumpir', {})[0].command, 'interrupt');
});

test('host interruption pauses deliveries before provider callbacks can restart work', async () => {
  const { Manager } = await import('../electron/manager');
  const s = chat();
  s.status = 'working';
  observeSession(s, 'ready', 100);
  let called = false;
  const host = {
    session: () => s,
    runtime: () => ({
      provider: {
        interrupt: async () => {
          called = true;
          assert.equal(s.deliveryPaused, true);
          s.status = 'ready';
          observeSession(s, 'working', 200);
        },
      },
    }),
    changed: () => {},
  };
  await Manager.prototype.interrupt.call(host as any, s.id);
  assert.equal(called, true);
  assert.equal(s.supervision?.outcome, 'interrupted');
});
test('a failed interruption leaves the running turn unresolved and the queues paused', async () => {
  const { Manager } = await import('../electron/manager');
  const s = chat();
  s.status = 'working';
  observeSession(s, 'ready', 100);
  const host = {
    session: () => s,
    runtime: () => ({
      provider: {
        interrupt: async () => {
          throw new Error('Motor no disponible');
        },
      },
    }),
    changed: () => {},
  };
  await assert.rejects(Manager.prototype.interrupt.call(host as any, s.id), /Motor no disponible/);
  assert.equal(s.supervision?.finishedAt, undefined);
  assert.equal(s.deliveryPaused, true);
});
test('an in-flight queued delivery is fenced again after asynchronous preparation', async () => {
  const { Manager } = await import('../electron/manager');
  const s = chat();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const host = {
    session: () => s,
    accounts: { removing: () => false },
    runtimes: new Map([[s.id, {}]]),
    exclusive: async (_id: string, operation: () => unknown) => {
      await gate;
      return operation();
    },
  };
  const delivery = (Manager.prototype as any).sendNow.call(
    host,
    s.id,
    'En cola',
    [],
    undefined,
    true,
  );
  s.deliveryPaused = true;
  release();
  await assert.rejects(delivery, /Envío pausado/);
  assert.deepEqual(s.messages, []);
});
test('Claude closes a runtime with surviving SDK input; legacy receipts use the same safe fallback', async () => {
  const { ClaudeRuntime } = await import('../electron/claude');
  for (const receipt of [undefined, { still_queued: ['pending-id'] }]) {
    const s = chat();
    s.status = 'working';
    let closed = false;
    const runtime = new ClaudeRuntime(
      s,
      {},
      () => {},
      async () => {},
    );
    (runtime as any).query = {
      interrupt: async () => receipt,
      close: () => {
        closed = true;
      },
    };
    (runtime as any).queue = [{ uuid: 'pending-id' }];
    await runtime.interrupt();
    assert.equal(closed, true);
    assert.deepEqual((runtime as any).queue, []);
    assert.match(s.notice ?? '', /interrupción/);
  }
});

test('a completed tools-only turn still reaches the review queue without resurfacing an older answer', async () => {
  const { attentionItems } = await import('../src/attention');
  const s = chat();
  s.messages = [
    { id: 'a', role: 'assistant', text: 'Respuesta anterior' },
    { id: 'u', role: 'user', text: 'Ejecuta la comprobación' },
    { id: 't', role: 'tool', text: 'Comprobación terminada' },
  ];
  s.status = 'working';
  observeSession(s, 'ready', 100);
  finishSession(s, 'completed', 200);
  s.status = 'ready';
  const queue = attentionItems([s], {});
  assert.equal(queue.length, 1);
  assert.equal(queue[0].label, 'Turno sin leer');
  assert.doesNotMatch(queue[0].detail, /Respuesta anterior/);
});
test('partial-question answers cannot be sent to an older host protocol', async () => {
  const { assertCompatibleAction } = await import('../src/runtime');
  assert.throws(
    () =>
      assertCompatibleAction({ runtime: { protocol: 51 } } as Snapshot, {
        type: 'approve',
        sessionId: 's',
        requestId: 'a',
        decision: 'accept',
        unanswered: { B: 'skipped' },
      }),
    /versión antigua/,
  );
});
