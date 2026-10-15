import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Manager } from '../electron/manager';
import { Store } from '../electron/store';
import { actionSchema } from '../electron/core';

test('project ordering persists without selecting projects or stopping their chats', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'desk-project-order-')));
  const m = new Manager(root, () => {});
  try {
    m.addAccount('claude');
    m.state.projects.push(
      ...['a', 'b', 'c'].map((id) => ({ id, name: id, path: path.join(root, id) })),
    );
    const session = m.newSession('b', 'claude-1');
    session.status = 'working';
    session.messages = [{ id: 'u', role: 'user', text: 'Keep working' }];
    const runtime = {} as any;
    m.runtimes.set(session.id, runtime);
    const selectedProject = m.state.selectedProject,
      selectedSession = m.state.selectedSession;
    m.moveProject('a', 'c');
    assert.deepEqual(
      m.state.projects.map((p) => p.id),
      ['b', 'c', 'a'],
    );
    assert.deepEqual(
      new Store(root).state.projects.map((p) => p.id),
      ['b', 'c', 'a'],
    );
    assert.equal(m.state.selectedProject, selectedProject);
    assert.equal(m.state.selectedSession, selectedSession);
    assert.equal(m.runtimes.get(session.id), runtime);
    assert.equal(session.status, 'working');
    assert.equal(session.messages[0].text, 'Keep working');
    assert.equal(m.state.projects.find((p) => p.id === 'b')?.path, path.join(root, 'b'));
    m.moveProject('a', 'b');
    assert.deepEqual(
      m.state.projects.map((p) => p.id),
      ['a', 'b', 'c'],
    );
    assert.throws(() => m.moveProject('missing', 'b'));
    assert.throws(() => m.moveProject('a', 'missing'));
    assert.deepEqual(
      m.state.projects.map((p) => p.id),
      ['a', 'b', 'c'],
    );
    m.moveProject('a', 'a');
    assert.deepEqual(
      m.state.projects.map((p) => p.id),
      ['a', 'b', 'c'],
    );
  } finally {
    m.runtimes.clear();
    await m.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('project ordering IPC validates both identities and rejects extra data', () => {
  assert.ok(
    actionSchema.safeParse({ type: 'moveProject', projectId: 'a', targetProjectId: 'b' }).success,
  );
  for (const action of [
    { type: 'moveProject', projectId: 'a' },
    { type: 'moveProject', projectId: '', targetProjectId: 'b' },
    { type: 'moveProject', projectId: 'a', targetProjectId: 'b', path: '/tmp/other' },
  ])
    assert.equal(actionSchema.safeParse(action).success, false);
});
