import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Teams } from '../electron/teams';
import { Store } from '../electron/store';
import { Coordinator, isCoordinationApproval } from '../electron/coordination';
import type { Session } from '../src/shared';
const chat = (id: string): Session => ({
  id,
  projectId: 'p',
  profile: 'claude-1',
  title: id,
  status: 'stopped',
  messages: [],
  approvals: [],
});
function fixture(send: (id: string, text: string) => Promise<unknown> = async () => {}) {
  const sessions = [chat('root'), chat('outside')];
  const teams = new Teams({
    sessions: () => sessions,
    create: (parent, projectId) => {
      const s = { ...chat(`child-${sessions.length}`), projectId };
      sessions.push(s);
      return s;
    },
    send,
    changed: () => {},
    projects: () => [{ id: 'p', name: 'Proyecto' }],
  });
  const spawn = (projectId = 'p') =>
    teams.call('root', {
      operation: 'spawn',
      title: 'Tarea',
      text: 'Revisa el proyecto',
      projectId,
    });
  return { sessions, teams, spawn };
}
test('coordinador supera cuatro subchats, conserva proyectos y rechaza nietos y acceso ajeno', () => {
  const { teams, spawn, sessions } = fixture();
  spawn('other-project');
  spawn();
  spawn();
  spawn();
  assert.equal(sessions[2].projectId, 'other-project');
  assert.equal(sessions[2].parentId, 'root');
  for (let i = 0; i < 8; i++) spawn();
  assert.throws(
    () => teams.call(sessions[2].id, { operation: 'spawn', title: 'Nieto', text: 'No' }),
    /coordinador/,
  );
  assert.throws(
    () => teams.call('root', { operation: 'read', targetId: 'outside' }),
    /mismo equipo/,
  );
  assert.throws(
    () => teams.call('outside', { operation: 'send', targetId: sessions[2].id, text: 'Intrusión' }),
    /mismo equipo/,
  );
  assert.equal(teams.members(sessions[2].id).length, 13);
});
test('vinculación rechaza ciclos, reparentado, terminales', () => {
  const { teams, sessions } = fixture();
  teams.link('root', 'outside');
  assert.throws(() => teams.link('outside', 'root'), /coordinador/);
  assert.throws(() => teams.link('root', 'outside'), /independiente/);
  sessions.push({ ...chat('terminal'), mode: 'terminal' });
  assert.throws(() => teams.link('root', 'terminal'), /terminales/);
});
test('mensajes esperan a que termine el turno y se entregan una sola vez, con remitente', async () => {
  const sent: string[] = [];
  let release!: () => void;
  const { teams, sessions, spawn } = fixture(async (_id, text) => {
    sent.push(text);
    await new Promise<void>((r) => {
      release = r;
    });
  });
  spawn();
  const child = sessions[2];
  child.status = 'working';
  teams.pump();
  assert.equal(sent.length, 0);
  child.status = 'ready';
  teams.pump();
  teams.pump();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /root/);
  assert.equal(child.teamMessages![0].status, 'sending');
  release();
  await new Promise((r) => setImmediate(r));
  teams.pump();
  assert.equal(sent.length, 1);
  assert.equal(child.teamMessages![0].status, 'delivered');
  teams.call(child.id, { operation: 'send', targetId: 'root', text: 'Resultado listo' });
  assert.equal(sessions[0].teamMessages![0].from, child.id);
});
test('fallos de entrega quedan visibles, sin reintentos infinitos', async () => {
  const { teams, sessions, spawn } = fixture(async () => {
    throw new Error('Inicia sesión');
  });
  spawn();
  teams.pump();
  await new Promise((r) => setImmediate(r));
  assert.equal(sessions[2].teamMessages![0].status, 'failed');
  assert.equal(sessions[2].teamMessages![0].error, 'Inicia sesión');
});
test('vínculos e historial de mensajes persisten sin ejecutar pendientes después de reiniciar', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-teams-'));
  try {
    const store = new Store(root),
      { sessions, spawn } = fixture();
    spawn();
    store.state.profiles = [{ id: 'claude-1', name: 'Claude', kind: 'claude' }];
    store.state.sessions = sessions;
    store.flush();
    const loaded = new Store(root).state.sessions[2];
    assert.equal(loaded.parentId, 'root');
    assert.equal(loaded.teamMessages![0].text, 'Revisa el proyecto');
    assert.equal(loaded.teamMessages![0].status, 'failed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('herramienta team exige capacidad de sesión válida y funciona también en worktrees', async () => {
  const coordinator = new Coordinator(),
    { teams, sessions } = fixture();
  coordinator.teamHandler = (s, input) => teams.call(s.id, input);
  coordinator.register(sessions[0], os.tmpdir(), true);
  try {
    const config = await coordinator.config('root');
    const url = config.env.AGENT_DESK_COORDINATION_URL.replace('/coordinate', '/team');
    const denied = await fetch(url, { method: 'POST', body: '{}' });
    assert.equal(denied.status, 403);
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.env.AGENT_DESK_COORDINATION_TOKEN}` },
      body: JSON.stringify({ operation: 'list' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).self, 'root');
    assert.equal(
      isCoordinationApproval('mcpServer/elicitation/request', {
        serverName: 'agent_desk',
        mode: 'form',
        message: 'tool "team"',
        _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: { operation: 'list' } },
        requestedSchema: { type: 'object', properties: {} },
      }),
      true,
    );
  } finally {
    await coordinator.close();
  }
});

test('gestor ejecuta la tarea del subchat sin cambiar la selección del coordinador', async () => {
  const { Manager } = await import('../electron/manager');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-team-manager-'));
  const manager = new Manager(directory, () => {});
  try {
    manager.state.profiles = [{ id: 'claude-1', name: 'Claude', kind: 'claude' }];
    manager.state.projects = [{ id: 'p', name: 'Proyecto', path: directory }];
    const parent = manager.newSession('p', 'claude-1', 'chat');
    const sent: string[] = [];
    manager.send = async (id, text) => {
      sent.push(id);
      assert.match(text, /Implementa tarea/);
      return true;
    };
    manager.teams.call(parent.id, { operation: 'spawn', title: 'Hijo', text: 'Implementa tarea' });
    await new Promise((resolve) => setImmediate(resolve));
    const child = manager.state.sessions.find((s) => s.parentId === parent.id)!;
    assert.deepEqual(sent, [child.id]);
    assert.equal(manager.state.selectedSession, parent.id);
    assert.equal(child.teamMessages![0].status, 'delivered');
    child.status = 'working';
    manager.teams.call(parent.id, { operation: 'send', targetId: child.id, text: 'Pendiente' });
    await manager.stop(child.id);
    assert.equal(child.teamMessages!.at(-1)!.status, 'failed');
  } finally {
    await manager.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('el agente descubre metadatos de chats independientes y puede vincularlos mediante team', () => {
  const { teams, spawn, sessions } = fixture();
  for (let i = 0; i < 6; i++) spawn();
  const list = teams.call('root', { operation: 'list' });
  assert.deepEqual(list.availableChats, [{ id: 'outside', title: 'outside', projectId: 'p' }]);
  teams.call('root', { operation: 'link', targetId: 'outside' });
  assert.equal(sessions[1].parentId, 'root');
  assert.equal(teams.members('root').length, 8);
  assert.throws(
    () => teams.call(sessions[2].id, { operation: 'link', targetId: 'root' }),
    /coordinador/,
  );
});

test('eliminar un chat lo borra de persistencia y conserva sus subchats independientes', async () => {
  const { Manager } = await import('../electron/manager');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-delete-chat-'));
  const manager = new Manager(directory, () => {});
  try {
    manager.state.profiles = [{ id: 'claude-1', name: 'Claude', kind: 'claude' }];
    manager.state.projects = [{ id: 'p', name: 'Proyecto', path: directory }];
    const parent = manager.newSession('p', 'claude-1', 'chat');
    const child = manager.newSession('p', 'claude-1', 'chat');
    child.parentId = parent.id;
    manager.state.selectedSession = parent.id;
    let cleaned = false;
    await manager.deleteSession(parent.id, async (sessions) => {
      assert.deepEqual(
        sessions.map((s) => s.id),
        [parent.id],
      );
      cleaned = true;
    });
    assert.ok(cleaned);
    assert.equal(manager.state.selectedSession, undefined);
    assert.equal(child.parentId, undefined);
    assert.equal(
      manager.state.sessions.some((s) => s.id === parent.id),
      false,
    );
    assert.equal(
      new Store(directory).state.sessions.some((s) => s.id === parent.id),
      false,
    );
  } finally {
    await manager.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('eliminar un chat no depende de que termine una operación en curso', async () => {
  const { Manager } = await import('../electron/manager');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-delete-busy-'));
  const manager = new Manager(directory, () => {});
  try {
    manager.state.profiles = [{ id: 'claude-1', name: 'Claude', kind: 'claude' }];
    manager.state.projects = [{ id: 'p', name: 'Proyecto', path: directory }];
    const s = manager.newSession('p', 'claude-1', 'chat');
    let release!: () => void;
    const busy = manager.exclusive(s.id, () => new Promise<void>((r) => (release = r)));
    const deleted = manager.deleteSession(s.id);
    await assert.rejects(
      manager.exclusive(s.id, async () => {}),
      /Se está eliminando/,
    );
    release();
    await busy;
    assert.equal(await deleted, true);
    assert.equal(
      manager.state.sessions.some((chat) => chat.id === s.id),
      false,
    );
  } finally {
    await manager.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
