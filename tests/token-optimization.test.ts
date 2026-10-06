import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { turnOptimization, savingInstructions } from '../electron/token-optimization';
import { actionSchema } from '../electron/core';
import { Store } from '../electron/store';
import { Manager } from '../electron/manager';
import type { ModelInfo } from '../src/shared';
const models: ModelInfo[] = ['haiku', 'sonnet', 'opus'].map((value) => ({
  value,
  displayName: value,
  description: '',
  defaultEffort: 'high',
  supportedEffortLevels: ['low', 'medium', 'high'],
}));
const base = {
  models,
  baseModel: 'opus',
  baseEffort: 'high',
  text: 'Traduce este título al inglés',
};
test('tres niveles, desactivado, complejidad, esfuerzo compatible y catálogo desconocido', () => {
  assert.equal(turnOptimization(base).model, 'opus');
  assert.equal(turnOptimization(base).effort, 'high');
  for (const [level, effort] of [
    [1, 'high'],
    [2, 'medium'],
    [3, 'low'],
  ] as const) {
    const choice = turnOptimization({ ...base, preferences: { level, autoModel: true } });
    assert.equal(choice.model, 'haiku');
    assert.equal(choice.effort, effort);
    assert.match(savingInstructions(level), /Respeta permisos/);
  }
  assert.equal(savingInstructions(0), '');
  const auto = { level: 3, autoModel: true } as const;
  for (const extra of [{ text: 'Revisa la seguridad' }, { images: true }, { planning: true }]) {
    const choice = turnOptimization({ ...base, ...extra, preferences: auto });
    assert.equal(choice.model, 'opus');
    assert.equal(choice.effort, 'high');
  }
  const follow = turnOptimization({
    ...base,
    text: 'sí, hazlo',
    hasHistory: true,
    previousModel: 'sonnet',
    previousEffort: 'medium',
    preferences: auto,
  });
  assert.equal(follow.model, 'sonnet');
  assert.equal(follow.effort, 'medium');
  assert.equal(turnOptimization({ ...base, preferences: auto, models: [] }).model, 'opus');
  assert.equal(turnOptimization({ ...base, preferences: auto, baseEffort: 'low' }).effort, 'low');
  assert.equal(
    turnOptimization({
      ...base,
      preferences: auto,
      models: [{ ...models[0], supportedEffortLevels: ['high'] }],
    }).effort,
    'high',
  );
});
test('preferencias aisladas por cuenta, persistencia y límites IPC', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-saving-'));
  try {
    const store = new Store(root);
    store.state.profiles = [
      { id: 'claude-1', kind: 'claude', name: 'Uno', optimization: { level: 3, autoModel: true } },
      { id: 'codex', kind: 'codex', name: 'Dos' },
    ];
    store.flush();
    assert.deepEqual(new Store(root).state.profiles, store.state.profiles);
    for (const optimization of [
      { level: 4, autoModel: true },
      { level: 2, autoModel: 'yes' },
      { level: 1, autoModel: true, bypassPermissions: true },
    ])
      assert.equal(
        actionSchema.safeParse({ type: 'configureOptimization', profile: 'claude-1', optimization })
          .success,
        false,
      );
    assert.equal(
      actionSchema.safeParse({
        type: 'configureOptimization',
        profile: 'claude-1',
        optimization: { level: 2, autoModel: true },
      }).success,
      true,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function harness(kind: 'claude' | 'codex') {
  const session: any = {
    id: 's',
    projectId: 'p',
    profile: kind === 'claude' ? 'claude-1' : 'codex',
    status: 'ready',
    title: 'Prueba',
    messages: [],
    approvals: [],
    account: {},
    info: { models },
    config: { model: 'opus', effort: 'high' },
    codexConfig: {
      model: 'opus',
      effort: 'high',
      sandbox: 'read-only',
      approvalPolicy: 'untrusted',
      developerInstructions: 'Instrucciones personales',
    },
  };
  const calls: any[] = [];
  const rt: any =
    kind === 'claude'
      ? {
          claude: {
            setModel: async (v: string) => calls.push(['model', v]),
            setEffort: async (v: string) => calls.push(['effort', v]),
            send: (v: string) => {
              calls.push(['send', v]);
              session.status = 'working';
            },
          },
        }
      : {
          rpc: {
            call: async (method: string, params: any) => {
              calls.push([method, params]);
              return { thread: { id: 'thread', turns: [] } };
            },
          },
        };
  const manager: Manager = Object.assign(Object.create(Manager.prototype), {
    store: {
      state: {
        profiles: [{ id: session.profile, optimization: { level: 3, autoModel: true } }],
        sessions: [session],
        projects: [{ id: 'p', path: '/tmp' }],
      },
    },
    operations: new Set(),
    runtimes: new Map([['s', rt]]),
    changed: () => {},
    account: async () => {},
    coordinator: { task: () => {}, config: async () => ({ command: 'test' }) },
  });
  return { manager, session, calls };
}
test('Claude aplica controles antes del envío, conserva colas y restaura ajustes manuales', async () => {
  const { manager, session, calls } = harness('claude');
  await manager.send('s', base.text);
  assert.deepEqual(calls, [
    ['model', 'haiku'],
    ['effort', 'low'],
    ['send', base.text],
  ]);
  calls.length = 0;
  await manager.send('s', 'Continúa');
  assert.deepEqual(calls, [['send', 'Continúa']]);
  assert.equal(session.config.model, 'opus');
  manager.configureOptimization('claude-1', { level: 0, autoModel: false });
  session.status = 'ready';
  calls.length = 0;
  await manager.send('s', 'Continúa');
  assert.deepEqual(calls, [
    ['model', 'opus'],
    ['effort', 'high'],
    ['send', 'Continúa'],
  ]);
});
test('Codex mantiene permisos, aplica política, actualiza al desactivar y restaura el modelo manual', async () => {
  const { manager, session, calls } = harness('codex');
  await manager.send('s', base.text);
  assert.equal(calls[0][0], 'thread/start');
  assert.equal(calls[0][1].sandbox, 'read-only');
  assert.match(calls[0][1].developerInstructions, /Instrucciones personales/);
  assert.ok(calls[0][1].developerInstructions.includes(savingInstructions(3)));
  assert.equal(calls[1][0], 'turn/start');
  assert.equal(calls[1][1].model, 'haiku');
  assert.equal(calls[1][1].effort, 'low');
  assert.equal(calls[1][1].approvalPolicy, 'untrusted');
  assert.equal(session.codexConfig.model, 'opus');
  manager.configureOptimization('codex', { level: 0, autoModel: false });
  session.status = 'ready';
  calls.length = 0;
  await manager.send('s', 'Continúa');
  assert.equal(calls[0][0], 'thread/resume');
  assert.ok(!calls[0][1].developerInstructions.includes(savingInstructions(3)));
  assert.equal(calls[1][1].model, 'opus');
  assert.equal(calls[1][1].effort, 'high');
});

test('rechazar un control Claude no envía la tarea y permite recuperar el modelo manual', async () => {
  const { manager, session, calls } = harness('claude');
  const runtime = manager.runtimes.get('s')!.claude!;
  const setEffort = runtime.setEffort;
  runtime.setEffort = async () => {
    throw new Error('Esfuerzo rechazado');
  };
  await assert.rejects(manager.send('s', base.text), /Esfuerzo rechazado/);
  assert.deepEqual(calls, [['model', 'haiku']]);
  runtime.setEffort = setEffort;
  manager.configureOptimization('claude-1', { level: 0, autoModel: false });
  calls.length = 0;
  await manager.send('s', base.text);
  assert.deepEqual(calls, [
    ['model', 'opus'],
    ['effort', 'high'],
    ['send', base.text],
  ]);
});
