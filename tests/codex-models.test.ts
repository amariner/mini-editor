import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchCodexModels, resolveCodexModel, selectCodexConfig } from '../electron/codex-models';
import { codexParams, mergeCodexConfig, actionSchema } from '../electron/core';
import { Store } from '../electron/store';
const models = [
  {
    value: 'model-a',
    displayName: 'A',
    description: '',
    isDefault: true,
    defaultEffort: 'medium',
    supportedEffortLevels: ['low', 'medium'],
  },
  {
    value: 'model-b',
    displayName: 'B',
    description: '',
    defaultEffort: 'high',
    supportedEffortLevels: ['high'],
  },
];
test('catálogo paginado: elimina ocultos y duplicados y conserva capacidades del servidor', async () => {
  const requests: any[] = [];
  const result = await fetchCodexModels(async (_, p: any) => {
    requests.push(p);
    return p.cursor
      ? {
          data: [
            {
              model: 'model-b',
              displayName: 'B',
              supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
            },
            { model: 'model-a' },
            { model: 'hidden', hidden: true },
          ],
          nextCursor: null,
        }
      : { data: [{ model: 'model-a' }], nextCursor: 'next' };
  });
  assert.equal(requests[1].cursor, 'next');
  assert.deepEqual(
    result.map((m) => m.value),
    ['model-a', 'model-b'],
  );
  assert.deepEqual(result[1].supportedEffortLevels, ['high']);
  await assert.rejects(
    fetchCodexModels(async () => ({ data: [], nextCursor: 'loop' })),
    /no ha completado/,
  );
  await assert.rejects(fetchCodexModels(async () => ({ unexpected: true })));
});
test('la selección rechaza modelos/esfuerzos desconocidos y resetea el esfuerzo al cambiar', () => {
  const before = mergeCodexConfig({ model: 'model-a', effort: 'low' });
  const next = selectCodexConfig(before, { model: 'model-b' }, models);
  assert.equal(next.effort, undefined);
  assert.equal(before.model, 'model-a');
  assert.throws(() => selectCodexConfig(before, { model: 'inventado' }, models), /catálogo/);
  assert.throws(() => selectCodexConfig(before, { effort: 'ultra' }, models), /no admite/);
  assert.equal(selectCodexConfig(next, { effort: 'high' }, models).effort, 'high');
  assert.equal(
    actionSchema.safeParse({ type: 'refreshCodexModels', sessionId: 's' }).success,
    true,
  );
});
test('volver a Por defecto envía valores concretos para sobrescribir el modelo de un hilo reanudado', () => {
  const selected = resolveCodexModel(
    mergeCodexConfig({ model: 'model-b', effort: 'high' }),
    models,
  );
  const explicit = codexParams(selected, '/tmp/project');
  assert.equal(explicit.thread.model, 'model-b');
  assert.equal(explicit.turn.model, 'model-b');
  assert.equal(explicit.turn.effort, 'high');
  const reset = codexParams(resolveCodexModel(mergeCodexConfig(), models), '/tmp/project');
  assert.equal(reset.thread.model, 'model-a');
  assert.equal(reset.turn.model, 'model-a');
  assert.equal(reset.turn.effort, 'medium');
});
test('restaurar la app conserva modelo y esfuerzo de cada sesión Codex y admite datos anteriores', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desk-model-unit-'));
  try {
    const store = new Store(root);
    store.state.profiles = [{ id: 'codex', name: 'Codex', kind: 'codex' }];
    store.state.sessions = [
      {
        id: 's',
        projectId: 'p',
        profile: 'codex',
        title: 'S',
        status: 'stopped',
        messages: [],
        approvals: [],
        codexConfig: mergeCodexConfig({ model: 'model-b', effort: 'high' }),
      },
      {
        id: 'old',
        projectId: 'p',
        profile: 'codex',
        title: 'Anterior',
        status: 'stopped',
        messages: [],
        approvals: [],
      },
    ];
    store.flush();
    const restored = new Store(root);
    assert.equal(restored.state.sessions[0].codexConfig?.model, 'model-b');
    assert.equal(restored.state.sessions[0].codexConfig?.effort, 'high');
    assert.equal(restored.state.sessions[1].codexConfig?.model, 'default');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
