import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  actionSchema,
  approvalResult,
  claudeArgs,
  cleanEnv,
  profileDirectory,
} from '../electron/core';
import { Store } from '../electron/store';
import { Rpc } from '../electron/rpc';

test('IPC rechaza rutas, operaciones y dimensiones arbitrarias', () => {
  assert.equal(actionSchema.safeParse({ type: 'exec', command: 'rm -rf' }).success, false);
  assert.equal(
    actionSchema.safeParse({ type: 'terminalResize', sessionId: 's', cols: 0, rows: 24 }).success,
    false,
  );
  assert.equal(actionSchema.safeParse({ type: 'send', sessionId: 's', text: '  ' }).success, false);
  assert.equal(
    actionSchema.safeParse({
      type: 'approve',
      sessionId: 's',
      requestId: 1,
      decision: 'acceptForSession',
    }).success,
    false,
  );
});
test('perfiles aislados sin heredar secretos ni proveedores', () => {
  const env = cleanEnv({
    HOME: '/Users/test',
    PATH: '/bin',
    ANTHROPIC_API_KEY: 'do-not-propagate',
    CLAUDE_CONFIG_DIR: '/global',
    CODEX_HOME: '/global',
    OPENAI_API_KEY: 'do-not-propagate',
    CLAUDE_CODE_OAUTH_TOKEN: 'do-not-propagate',
    ANTHROPIC_AUTH_TOKEN: 'do-not-propagate',
  });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(env.CODEX_HOME, undefined);
  assert.equal(env.HOME, '/Users/test');
  assert.notEqual(profileDirectory('/local', 'claude-1'), profileDirectory('/local', 'claude-2'));
  assert.deepEqual(claudeArgs({ reference: 'uuid', attempted: true }).slice(0, 2), [
    '--resume',
    'uuid',
  ]);
  assert.deepEqual(claudeArgs({ reference: 'uuid' }).slice(0, 2), ['--session-id', 'uuid']);
});
test('aprobaciones de un solo uso, permisos mínimos y preguntas completas', () => {
  assert.deepEqual(approvalResult('item/commandExecution/requestApproval', {}, 'accept'), {
    decision: 'accept',
  });
  assert.deepEqual(approvalResult('item/fileChange/requestApproval', {}, 'decline'), {
    decision: 'decline',
  });
  assert.throws(() =>
    approvalResult(
      'item/commandExecution/requestApproval',
      { availableDecisions: ['cancel'] },
      'accept',
    ),
  );
  assert.deepEqual(
    approvalResult(
      'item/permissions/requestApproval',
      { permissions: { network: { enabled: true } } },
      'decline',
    ),
    { permissions: {}, scope: 'turn' },
  );
  assert.deepEqual(
    approvalResult(
      'item/permissions/requestApproval',
      { permissions: { network: { enabled: true } } },
      'accept',
    ),
    { permissions: { network: { enabled: true } }, scope: 'turn' },
  );
  assert.throws(() =>
    approvalResult('item/tool/requestUserInput', { questions: [{ id: 'q' }] }, 'accept'),
  );
  assert.deepEqual(
    approvalResult('item/tool/requestUserInput', { questions: [{ id: 'q' }] }, 'accept', {
      q: 'respuesta',
    }),
    { answers: { q: { answers: ['respuesta'] } } },
  );
  assert.throws(() => approvalResult('unknown', {}, 'accept'));
});
test('persistencia restaura referencias y conversación, nunca procesos, autenticación o aprobaciones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desk-unit-'));
  try {
    const store = new Store(dir);
    store.state.profiles = [{ id: 'codex', name: 'Codex', kind: 'codex' }];
    store.state.projects = [{ id: 'p', name: 'Proyecto', path: '/tmp/project' }];
    store.state.sessions = [
      {
        id: 's',
        projectId: 'p',
        profile: 'codex',
        title: 'Sesión',
        reference: 'thread-123',
        status: 'working',
        turnId: 'turn-123',
        messages: [{ id: 'm', role: 'assistant', text: 'Mensaje' }],
        account: 'private@example.com',
        approvals: [{ id: 1, method: 'approval', params: {} }],
        stats: {
          cost: 0,
          turns: 0,
          durationMs: 0,
          inputTokens: 1234,
          outputTokens: 340,
          tokensReported: true,
        },
      },
    ];
    store.flush();
    const restored = new Store(dir);
    assert.equal(restored.state.sessions[0].reference, 'thread-123');
    assert.equal(restored.state.sessions[0].status, 'stopped');
    assert.equal(restored.state.sessions[0].messages[0].text, 'Mensaje');
    assert.deepEqual(restored.state.sessions[0].approvals, []);
    assert.equal(restored.state.sessions[0].account, undefined);
    assert.equal(restored.state.sessions[0].stats?.tokensReported, true);
    assert.equal(restored.state.sessions[0].stats?.inputTokens, 1234);
    assert.equal(fs.statSync(path.join(dir, 'state.json')).mode & 0o777, 0o600);
    fs.writeFileSync(path.join(dir, 'state.json'), 'invalid');
    assert.throws(() => new Store(dir));
    assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), 'invalid');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('transporte RPC correlaciona respuestas fragmentadas, errores y solicitudes bidireccionales (fixture de protocolo)', async () => {
  const script = `process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',d=>{b+=d;let n;while((n=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(m.method==='ok'){const r=JSON.stringify({id:m.id,result:{value:42}})+'\\n';process.stdout.write(r.slice(0,5));setTimeout(()=>process.stdout.write(r.slice(5)),5)}else if(m.method==='fail')process.stdout.write(JSON.stringify({id:m.id,error:{code:-32601,message:'unsupported'}})+'\\n');else if(m.method==='request')process.stdout.write(JSON.stringify({id:99,method:'approval',params:{}})+'\\n');else if(m.id===99)process.stdout.write(JSON.stringify({method:'resolved',params:m.result})+'\\n')}});`;
  const rpc = new Rpc(process.execPath, ['-e', script], os.tmpdir(), process.env);
  try {
    assert.deepEqual(await rpc.call('ok'), { value: 42 });
    await assert.rejects(rpc.call('fail'), /unsupported/);
    const notification = new Promise<any>((resolve) => rpc.once('notification', resolve));
    rpc.once('request', (m) => rpc.respond(m.id, { decision: 'decline' }));
    rpc.send({ method: 'request' });
    assert.equal((await notification).params.decision, 'decline');
    await assert.rejects(rpc.call('timeout', {}, 30), /Tiempo agotado/);
  } finally {
    await rpc.stop();
  }
  assert.equal(rpc.closed, true);
});

test('cerrar un grupo termina también un proceso que ignora SIGTERM', async () => {
  const { spawn } = await import('node:child_process');
  const { reapGroup, groupExists } = await import('../electron/processes');
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.stdout.write('ready')"],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  await new Promise((resolve) => child.stdout!.once('data', resolve));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  assert.equal(groupExists(child.pid!), true);
  await reapGroup(child.pid!);
  await exited;
  assert.equal(groupExists(child.pid!), false);
});

test('streaming mantiene orden, aísla threads y reemplaza el delta por el mensaje final sin duplicados', async () => {
  const { applyCodexEvent } = await import('../electron/codex-events');
  const s: import('../src/shared').Session = {
    id: 's',
    projectId: 'p',
    profile: 'codex',
    title: 'S',
    reference: 'thread-a',
    status: 'ready',
    messages: [],
    approvals: [],
  };
  applyCodexEvent(s, 'turn/started', { threadId: 'thread-b', turn: { id: 'other' } });
  assert.equal(s.status, 'ready');
  applyCodexEvent(s, 'turn/started', { threadId: 'thread-a', turn: { id: 'turn' } });
  assert.equal(s.status, 'working');
  applyCodexEvent(s, 'item/agentMessage/delta', {
    threadId: 'thread-a',
    itemId: 'm',
    delta: 'Hola ',
  });
  applyCodexEvent(s, 'item/agentMessage/delta', {
    threadId: 'thread-a',
    itemId: 'm',
    delta: 'mundo',
  });
  assert.equal(s.messages[0].text, 'Hola mundo');
  applyCodexEvent(s, 'item/completed', {
    threadId: 'thread-a',
    item: { id: 'm', type: 'agentMessage', text: 'Hola mundo.' },
  });
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].text, 'Hola mundo.');
  s.approvals = [
    { id: 1, method: 'item/commandExecution/requestApproval', params: {} },
    { id: 2, method: 'item/fileChange/requestApproval', params: {} },
  ];
  s.status = 'waiting';
  applyCodexEvent(s, 'serverRequest/resolved', { threadId: 'thread-a', requestId: 1 });
  assert.equal(s.status, 'waiting');
  assert.equal(s.approvals.length, 1);
  applyCodexEvent(s, 'serverRequest/resolved', { threadId: 'thread-a', requestId: 2 });
  assert.equal(s.status, 'working');
  applyCodexEvent(s, 'turn/completed', {
    threadId: 'thread-a',
    turn: { id: 'turn', status: 'interrupted' },
  });
  assert.equal(s.status, 'ready');
  assert.equal(s.turnId, undefined);
  assert.deepEqual(s.approvals, []);
});
