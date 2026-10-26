import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeRuntime } from '../electron/claude';
import { Manager } from '../electron/manager';
import { PendingInputs } from '../electron/pending-inputs';
import type { Session } from '../src/shared';

const chat = (id = 's'): Session => ({
  id,
  projectId: 'p',
  profile: 'claude-1',
  title: 'Chat',
  status: 'working',
  messages: [],
  approvals: [],
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('streaming one chat does not recalculate MCP for every other open chat', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-runtime-efficiency-'));
  const events: unknown[] = [];
  const manager = new Manager(root, (event) => events.push(event));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  manager.state.profiles = [{ id: 'claude-1', name: 'Claude', kind: 'claude' }];
  manager.state.projects = [{ id: 'p', name: 'Project', path: root }];
  manager.state.sessions = Array.from({ length: 200 }, (_, index) => chat(`s${index}`));
  for (const s of manager.state.sessions)
    manager.runtimes.set(s.id, { buffer: '', sequence: 0, mcpIds: [], mcpSignature: '' });
  const signature = t.mock.method(manager.mcp, 'signature');
  try {
    const active = manager.state.sessions[0];
    for (let delta = 0; delta < 100; delta++) manager.changed(active);
    await tick();
    assert.equal(signature.mock.callCount(), 100);
    assert.equal(events.length, 0);
    t.mock.timers.tick(30);
    assert.equal(events.length, 1);
    assert.equal(active.mcpPending, false);
    const applied = active.mcpAppliedIds;
    manager.changed(active);
    assert.equal(active.mcpAppliedIds, applied);

    // A project/configuration change still updates all chats immediately.
    manager.state.projects[0].mcpConnectionIds = ['new-connection'];
    manager.changed();
    assert.ok(manager.state.sessions.every((s) => s.mcpPending === true));
    assert.equal(signature.mock.callCount(), 301);
  } finally {
    manager.runtimes.clear();
    await manager.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('input queue checks runtime readiness only for chats with pending input', async () => {
  const sessions = Array.from({ length: 1000 }, (_, index) => chat(`s${index}`));
  const checked: string[] = [];
  const sent: string[] = [];
  const queue = new PendingInputs({
    sessions: () => sessions,
    ready: (s) => {
      checked.push(s.id);
      return s.status === 'ready';
    },
    send: async (id) => {
      sent.push(id);
    },
    changed: () => {},
  });
  queue.pump();
  assert.deepEqual(checked, []);
  queue.enqueue(sessions[7], 'Continue after the current turn', []);
  queue.pump();
  assert.deepEqual(checked, ['s7']);
  assert.deepEqual(sent, []);
  sessions[7].status = 'ready';
  queue.pump();
  await tick();
  queue.pump();
  assert.deepEqual(checked, ['s7', 's7']);
  assert.deepEqual(sent, ['s7']);
});

function claude() {
  const runtime = new ClaudeRuntime(
    chat(),
    {},
    () => {},
    async () => {},
  );
  const calls: unknown[] = [];
  const query = {
    setModel: async (model: string | undefined) => {
      calls.push(['model', model]);
    },
    applyFlagSettings: async (settings: unknown) => {
      calls.push(['flags', settings]);
    },
  };
  (runtime as any).query = query;
  return { runtime, calls, query };
}

test('repeated Claude turns reuse acknowledged model and effort settings', async () => {
  const { runtime, calls } = claude();
  for (let turn = 0; turn < 20; turn++) {
    await runtime.setModel('sonnet');
    await runtime.setEffort('medium');
  }
  assert.deepEqual(calls, [
    ['model', 'sonnet'],
    ['flags', { effortLevel: 'medium' }],
  ]);
  await runtime.setModel('opus');
  await runtime.setEffort('medium');
  await runtime.setEffort(undefined);
  await runtime.setEffort(undefined);
  assert.deepEqual(calls.slice(2), [
    ['model', 'opus'],
    ['flags', { effortLevel: 'medium' }],
    ['flags', { effortLevel: null }],
  ]);
});

test('failed Claude configuration is retried and a new runtime does not inherit the cache', async () => {
  const { runtime, query, calls } = claude();
  const apply = query.applyFlagSettings;
  query.applyFlagSettings = async () => {
    throw new Error('Temporary failure');
  };
  await runtime.setModel('default');
  await assert.rejects(runtime.setEffort('high'), /Temporary failure/);
  query.applyFlagSettings = apply;
  await runtime.setEffort('high');
  assert.deepEqual(calls, [
    ['model', undefined],
    ['flags', { effortLevel: 'high' }],
  ]);
  const fresh = claude();
  await fresh.runtime.setModel('default');
  await fresh.runtime.setEffort('high');
  assert.deepEqual(fresh.calls, calls);
});

test('a failed model change does not suppress the retry or its effort update', async () => {
  const { runtime, query, calls } = claude();
  await runtime.setModel('sonnet');
  await runtime.setEffort('medium');
  const set = query.setModel;
  query.setModel = async () => {
    throw new Error('Model unavailable');
  };
  await assert.rejects(runtime.setModel('opus'), /Model unavailable/);
  query.setModel = set;
  await runtime.setModel('opus');
  await runtime.setEffort('medium');
  assert.deepEqual(calls.slice(2), [
    ['model', 'opus'],
    ['flags', { effortLevel: 'medium' }],
  ]);
});

test('concurrent Claude controls preserve the last selection instead of skipping a cached value', async () => {
  const { runtime, query, calls } = claude();
  await runtime.setModel('sonnet');
  await runtime.setEffort('medium');
  let release!: () => void;
  const original = query.setModel;
  query.setModel = async (model) => {
    await original(model);
    if (model === 'opus') await new Promise<void>((resolve) => (release = resolve));
  };
  const first = runtime.setModel('opus');
  await tick();
  const second = runtime.setModel('sonnet');
  const effort = runtime.setEffort('medium');
  assert.deepEqual(calls.slice(2), [['model', 'opus']]);
  release();
  await Promise.all([first, second, effort]);
  assert.deepEqual(calls.slice(2), [
    ['model', 'opus'],
    ['model', 'sonnet'],
    ['flags', { effortLevel: 'medium' }],
  ]);
});

test('native Claude initialization invalidates acknowledged controls', async () => {
  const { runtime, query, calls } = claude();
  await runtime.setModel('sonnet');
  await runtime.setEffort('medium');
  (query as any)[Symbol.asyncIterator] = async function* () {
    yield { type: 'system', subtype: 'init', model: 'opus', effort: 'high' };
  };
  await (runtime as any).consume();
  assert.equal(runtime.s.info?.model, 'opus');
  await runtime.setModel('sonnet');
  await runtime.setEffort('medium');
  assert.deepEqual(calls.slice(2), [
    ['model', 'sonnet'],
    ['flags', { effortLevel: 'medium' }],
  ]);
});

test('an init during a control request cannot restore its obsolete cache on acknowledgement', async () => {
  const { runtime, query, calls } = claude();
  let release!: () => void;
  const original = query.setModel;
  query.setModel = async (model) => {
    await original(model);
    await new Promise<void>((resolve) => (release = resolve));
  };
  const pending = runtime.setModel('sonnet');
  await tick();
  (query as any)[Symbol.asyncIterator] = async function* () {
    yield { type: 'system', subtype: 'init', model: 'opus', effort: 'high' };
  };
  await (runtime as any).consume();
  release();
  await pending;
  assert.equal(runtime.s.info?.model, 'opus');
  query.setModel = original;
  await runtime.setModel('sonnet');
  assert.deepEqual(calls, [
    ['model', 'sonnet'],
    ['model', 'sonnet'],
  ]);
});

test('a lost model acknowledgement cannot suppress restoring the previous model and effort', async () => {
  const { runtime, query, calls } = claude();
  await runtime.setModel('sonnet');
  await runtime.setEffort('medium');
  const original = query.setModel;
  query.setModel = async (model) => {
    await original(model);
    if (model === 'opus') throw new Error('Acknowledgement lost after applying model');
  };
  await assert.rejects(runtime.setModel('opus'), /Acknowledgement lost/);
  await runtime.setModel('sonnet');
  await runtime.setEffort('medium');
  assert.deepEqual(calls.slice(2), [
    ['model', 'opus'],
    ['model', 'sonnet'],
    ['flags', { effortLevel: 'medium' }],
  ]);
});

test('a lost effort acknowledgement cannot suppress restoring the previous effort', async () => {
  const { runtime, query, calls } = claude();
  await runtime.setEffort('medium');
  const original = query.applyFlagSettings;
  query.applyFlagSettings = async (settings) => {
    await original(settings);
    if ((settings as any).effortLevel === 'high')
      throw new Error('Acknowledgement lost after applying effort');
  };
  await assert.rejects(runtime.setEffort('high'), /Acknowledgement lost/);
  await runtime.setEffort('medium');
  assert.deepEqual(calls, [
    ['flags', { effortLevel: 'medium' }],
    ['flags', { effortLevel: 'high' }],
    ['flags', { effortLevel: 'medium' }],
  ]);
});
