import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { codexParams, approvalResult, mergeCodexConfig } from '../electron/core';
import { Manager } from '../electron/manager';
import {
  codexApprovalChoices,
  codexPermissionLabel,
  codexPermissionModes,
} from '../src/codex-permissions';
import { CodexApproval } from '../src/chat';
import { assertCompatibleAction } from '../src/runtime';
import type { Session } from '../src/shared';

const command = 'item/commandExecution/requestApproval';
const permissions = 'item/permissions/requestApproval';

test('cada modo envía sandbox y aprobación juntos al hilo y a cada turno', () => {
  for (const mode of codexPermissionModes) {
    const config = mergeCodexConfig(mode);
    const params = codexParams(config, '/project');
    assert.equal(params.thread.sandbox, mode.sandbox);
    assert.equal(params.turn.approvalPolicy, mode.approvalPolicy);
    assert.equal(codexPermissionLabel(config), mode.name);
    if (mode.sandbox === 'danger-full-access')
      assert.deepEqual(params.turn.sandboxPolicy, { type: 'dangerFullAccess' });
    else {
      assert.equal(params.turn.sandboxPolicy.networkAccess, false);
      if (mode.sandbox === 'read-only') assert.equal(params.turn.sandboxPolicy.type, 'readOnly');
      else
        assert.deepEqual(params.turn.sandboxPolicy, {
          type: 'workspaceWrite',
          writableRoots: ['/project'],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        });
    }
  }
  assert.match(
    codexPermissionLabel(mergeCodexConfig({ approvalPolicy: 'never' })),
    /Rechazar sin preguntar/,
  );
  assert.notEqual(
    codexPermissionLabel(
      mergeCodexConfig({ sandbox: 'danger-full-access', approvalPolicy: 'untrusted' }),
    ),
    'Acceso total',
  );
});

test('un hilo cargado aplica acceso total y su revocación en el siguiente turno sin reiniciar', async () => {
  const session: Session = {
    id: 's',
    projectId: 'p',
    profile: 'codex',
    title: 'Prueba',
    status: 'ready',
    messages: [],
    approvals: [],
    account: 'fixture',
    reference: 'thread',
    codexConfig: mergeCodexConfig(),
  };
  const calls: any[] = [];
  const runtime = {
    loaded: true,
    optimizationLevel: 0,
    rpc: {
      call: async (method: string, params: any) => {
        calls.push([method, params]);
        return {};
      },
    },
  };
  const manager: Manager = Object.assign(Object.create(Manager.prototype), {
    store: {
      state: {
        profiles: [{ id: 'codex' }],
        sessions: [session],
        projects: [{ id: 'p', path: '/project' }],
      },
    },
    operations: new Set(),
    operationWork: new Map(),
    removingProjects: new Map(),
    accounts: { state: {}, removing: () => false },
    runtimes: new Map([['s', runtime]]),
    changed: () => {},
    account: async () => {},
    coordinator: { task: () => {} },
  });
  assert.deepEqual(
    await manager.configureCodex('s', { sandbox: 'danger-full-access', approvalPolicy: 'never' }),
    { restart: false },
  );
  await manager.send('s', 'Haz la tarea');
  assert.equal(calls[0][0], 'turn/start');
  assert.deepEqual(calls[0][1].sandboxPolicy, { type: 'dangerFullAccess' });
  assert.equal(calls[0][1].approvalPolicy, 'never');
  await manager.configureCodex('s', { sandbox: 'read-only', approvalPolicy: 'untrusted' });
  assert.match(session.notice!, /siguiente mensaje/);
  session.status = 'ready';
  await manager.send('s', 'Lee el archivo');
  assert.deepEqual(calls[1][1].sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(calls[1][1].approvalPolicy, 'untrusted');
  assert.equal(session.notice, undefined);
  session.status = 'ready';
  await manager.configureCodex('s', { sandbox: 'workspace-write' });
  assert.equal(session.notice, undefined);
});

test('la duración autorizada se conserva en la respuesta y no se eleva al aprobar una vez', () => {
  const params = { availableDecisions: ['accept', 'acceptForSession', 'decline'] };
  assert.deepEqual(approvalResult(command, params, 'accept'), { decision: 'accept' });
  assert.deepEqual(approvalResult(command, params, 'always'), { decision: 'acceptForSession' });
  assert.throws(() => approvalResult(command, { availableDecisions: ['accept'] }, 'always'));
  assert.throws(() => approvalResult(command, {}, 'always'));
  const requested = {
    permissions: { network: { enabled: true }, fileSystem: { write: ['/outside'] } },
  };
  assert.deepEqual(approvalResult(permissions, requested, 'always'), {
    permissions: requested.permissions,
    scope: 'session',
  });
  assert.deepEqual(approvalResult(permissions, requested, 'accept'), {
    permissions: requested.permissions,
    scope: 'turn',
  });
  assert.deepEqual(approvalResult(permissions, requested, 'decline'), {
    permissions: {},
    scope: 'turn',
  });
});

test('la interfaz ofrece únicamente decisiones admitidas y resuelve cancelaciones', () => {
  const params = { availableDecisions: ['acceptForSession', 'cancel'] };
  const choices = codexApprovalChoices(command, params);
  assert.deepEqual(
    choices.map((c) => c.label),
    ['Permitir durante este chat', 'Cancelar tarea'],
  );
  assert.deepEqual(approvalResult(command, params, choices[0].decision), {
    decision: 'acceptForSession',
  });
  assert.deepEqual(approvalResult(command, params, choices[1].decision), { decision: 'cancel' });
  assert.deepEqual(codexApprovalChoices(command, { availableDecisions: [] }), []);
  assert.throws(
    () =>
      assertCompatibleAction(undefined, {
        type: 'approve',
        sessionId: 's',
        requestId: 1,
        decision: 'always',
      }),
    /versión antigua/,
  );
});

test('la tarjeta muestra el acceso y distingue permiso por tarea, por chat y rechazo', () => {
  const out = renderToStaticMarkup(
    React.createElement(CodexApproval, {
      approval: {
        id: 1,
        method: permissions,
        params: {
          permissions: { network: { enabled: true }, fileSystem: { write: ['/outside'] } },
        },
      },
      session: { id: 's', messages: [] } as any,
      run: async () => {},
    }),
  );
  assert.match(out, /Acceso a la red/);
  assert.match(out, /Escribir: <code>\/outside<\/code>/);
  assert.match(out, /Permitir durante esta tarea/);
  assert.match(out, /Permitir durante este chat/);
  assert.match(out, /Rechazar/);
});
