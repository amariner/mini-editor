import test from 'node:test';
import assert from 'node:assert/strict';
import { stopAccountSessions } from '../electron/account-guard';
import { actionSchema } from '../electron/core';
import type { Session } from '../src/shared';
const sessions: Session[] = [
  {
    id: 'c1',
    projectId: 'a',
    profile: 'claude-1',
    status: 'terminal',
    title: '',
    messages: [],
    approvals: [],
  },
  {
    id: 'c2',
    projectId: 'b',
    profile: 'claude-2',
    status: 'ready',
    title: '',
    messages: [],
    approvals: [],
  },
  {
    id: 'x1',
    projectId: 'c',
    profile: 'codex',
    status: 'working',
    title: '',
    messages: [],
    approvals: [],
  },
  {
    id: 'x2',
    projectId: 'd',
    profile: 'codex',
    status: 'ready',
    title: '',
    messages: [],
    approvals: [],
  },
];
test('cambio de cuenta: exige confirmación y detiene solo las sesiones del perfil en todos sus proyectos', async () => {
  const running = new Map(sessions.map((s) => [s.id, {}]));
  const stopped: string[] = [];
  const stop = async (id: string) => {
    stopped.push(id);
    running.delete(id);
  };
  await assert.rejects(
    stopAccountSessions('codex', false, sessions, new Set(), running, stop),
    /Confirma/,
  );
  assert.deepEqual(stopped, []);
  await stopAccountSessions('codex', true, sessions, new Set(), running, stop);
  assert.deepEqual(stopped, ['x1', 'x2']);
  assert.deepEqual([...running.keys()], ['c1', 'c2']);
});
test('el cierre de cuenta no continúa si una parada falla o no confirma la salida', async () => {
  const running = new Map(sessions.map((s) => [s.id, {}]));
  await assert.rejects(
    stopAccountSessions('codex', true, sessions, new Set(), running, async () => {
      throw new Error('Fallo de parada');
    }),
    /Fallo de parada/,
  );
  assert.equal(running.has('x1'), true);
  await assert.rejects(
    stopAccountSessions('codex', true, sessions, new Set(), running, async () => {}),
    /No se ha confirmado/,
  );
});
test('se rechaza el cambio de cuenta durante un arranque pendiente aunque aún no haya proceso', async () => {
  await assert.rejects(
    stopAccountSessions('codex', true, sessions, new Set(['x1']), new Map(), async () => {}),
    /operación de agente/,
  );
});
test('IPC de cuentas admite solo perfiles conocidos y exige confirmación explícita', () => {
  assert.equal(
    actionSchema.safeParse({ type: 'accountLogout', profile: '../../global', stopSessions: true })
      .success,
    false,
  );
  assert.equal(actionSchema.safeParse({ type: 'accountLogout', profile: 'codex' }).success, false);
  assert.equal(
    actionSchema.safeParse({ type: 'accountLogout', profile: 'codex', stopSessions: true }).success,
    true,
  );
  assert.equal(
    actionSchema.safeParse({ type: 'accountLogin', profile: 'claude-2', stopSessions: false })
      .success,
    true,
  );
});

import { claudeAccount, codexAccount } from '../electron/account-state';
test('se interpreta el método real claude.ai y solo se expone identidad no secreta', () => {
  assert.deepEqual(
    claudeAccount({
      loggedIn: true,
      authMethod: 'claude.ai',
      email: 'perfil@example.com',
      accessToken: 'test-secret',
    }),
    { status: 'signedIn', label: 'perfil@example.com', plan: undefined },
  );
  assert.deepEqual(claudeAccount({ loggedIn: false, authMethod: 'none' }), {
    status: 'signedOut',
    label: undefined,
    plan: undefined,
  });
  assert.throws(() => claudeAccount({ loggedIn: true, authMethod: 'api_key' }), /suscripción/);
  assert.throws(() => claudeAccount({}), /estado de cuenta/);
});
test('estado Codex: cuenta ausente, ChatGPT o proveedor no admitido', () => {
  assert.deepEqual(codexAccount({ account: null }), {
    status: 'signedOut',
    label: undefined,
    plan: undefined,
  });
  assert.deepEqual(
    codexAccount({
      account: { type: 'chatgpt', email: 'perfil@example.com', accessToken: 'test-secret' },
    }),
    { status: 'signedIn', label: 'perfil@example.com', plan: undefined },
  );
  assert.throws(() => codexAccount({ account: { type: 'apiKey' } }), /ChatGPT/);
  assert.throws(() => codexAccount({}), /estado de cuenta/);
});

test('el plan procede del proveedor y nunca se conserva al cerrar sesión', () => {
  assert.equal(
    claudeAccount({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }).plan,
    'max',
  );
  assert.equal(codexAccount({ account: { type: 'chatgpt', planType: 'pro' } }).plan, 'pro');
  assert.equal(claudeAccount({ loggedIn: false, subscriptionType: 'max' }).plan, undefined);
  assert.equal(codexAccount({ account: null }).plan, undefined);
});
