import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store';
import { actionSchema, profileDirectory } from '../electron/core';
import { isCodex, profiles } from '../src/shared';
test('perfiles adicionales: rutas aisladas, proveedor correcto y validación IPC', () => {
  for (const id of ['claude-3', 'codex-2'])
    assert.equal(actionSchema.safeParse({ type: 'accountRefresh', profile: id }).success, true);
  for (const id of [
    '../../codex',
    'codex/2',
    'claude-0',
    'codex-',
    'global',
    'claude-1/../codex',
  ]) {
    assert.equal(actionSchema.safeParse({ type: 'accountRefresh', profile: id }).success, false);
    assert.throws(() => profileDirectory('/tmp/desk', id));
  }
  assert.notEqual(profileDirectory('/tmp/desk', 'codex'), profileDirectory('/tmp/desk', 'codex-2'));
  assert.equal(isCodex('codex-2'), true);
  assert.equal(isCodex('claude-3'), false);
  assert.equal(actionSchema.safeParse({ type: 'addAccount', kind: 'api-key' }).success, false);
});
test('migración y persistencia de perfiles y conversaciones; rechaza proveedor inconsistente', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-profiles-'));
  try {
    fs.writeFileSync(
      path.join(root, 'state.json'),
      JSON.stringify({ projects: [], sessions: [], tools: {} }),
    );
    const store = new Store(root);
    assert.deepEqual(store.state.profiles, profiles);
    store.state.profiles!.push({ id: 'codex-2', name: 'Trabajo', kind: 'codex' });
    store.state.sessions.push({
      id: 's',
      projectId: 'p',
      profile: 'codex-2',
      title: 'Tarea',
      status: 'working',
      messages: [],
      approvals: [],
      reference: 'r',
      codexConfig: {
        model: 'default',
        approvalPolicy: 'untrusted',
        sandbox: 'workspace-write',
        personality: 'none',
        developerInstructions: '',
      },
    });
    store.flush();
    const restored = new Store(root);
    assert.equal(restored.state.sessions[0].profile, 'codex-2');
    assert.equal(restored.state.sessions[0].status, 'stopped');
    assert.equal(restored.state.profiles!.at(-1)!.name, 'Trabajo');
    const data = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
    data.profiles.at(-1).kind = 'claude';
    fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify(data));
    assert.throws(() => new Store(root), /state.json no es válido/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
