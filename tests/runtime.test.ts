import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IPC_VERSION,
  assertCompatibleAction,
  compatibleRuntime,
  actionError,
  RESTART_NOTICE,
} from '../src/runtime';
import type { Snapshot } from '../src/shared';

const oldState: Snapshot = { projects: [], sessions: [], tools: {}, dataDir: '/tmp/example' };
test('un proceso antiguo bloquea funciones nuevas pero conserva controles para detener agentes', () => {
  assert.equal(compatibleRuntime(oldState), false);
  for (const type of ['refreshCodexModels', 'configureCodex', 'restartApp', 'start'] as const)
    assert.throws(
      () => assertCompatibleAction(oldState, { type, sessionId: 's', config: {} }),
      /versión antigua/,
    );
  assert.doesNotThrow(() => assertCompatibleAction(oldState, { type: 'stop', sessionId: 's' }));
  assert.doesNotThrow(() =>
    assertCompatibleAction(oldState, { type: 'interrupt', sessionId: 's' }),
  );
  assert.doesNotThrow(() =>
    assertCompatibleAction(oldState, { type: 'select', projectId: 'p', sessionId: 's' }),
  );
});
test('solo la versión compatible habilita nuevas acciones y los errores anteriores son legibles', () => {
  const state = {
    ...oldState,
    runtime: { protocol: IPC_VERSION, updateAvailable: false, restartSupported: true },
  };
  assert.doesNotThrow(() =>
    assertCompatibleAction(state, { type: 'refreshCodexModels', sessionId: 's' }),
  );
  assert.equal(
    compatibleRuntime({ ...state, runtime: { ...state.runtime, protocol: IPC_VERSION + 1 } }),
    false,
  );
  assert.equal(
    actionError(
      new Error(
        'Error invoking remote method \'desk:action\': Error: [{"code":"invalid_union","note":"No matching discriminator"}]',
      ),
    ),
    RESTART_NOTICE,
  );
  assert.equal(
    actionError(
      new Error("Error invoking remote method 'desk:action': Error: No se pudo conectar"),
    ),
    'No se pudo conectar',
  );
});
