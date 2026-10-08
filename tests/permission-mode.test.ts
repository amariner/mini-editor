import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Manager } from '../electron/manager';
import { claudeOptions, mergeConfig } from '../electron/core';
import { permissionModes } from '../src/shared';
import { Store } from '../electron/store';

test('manual and plan sessions support later explicit bypass without enabling it by default or removing deny rules', () => {
  for (const permissionMode of ['default', 'plan', 'dontAsk', 'bypassPermissions'] as const) {
    const config = mergeConfig({ permissionMode, disallowedTools: ['Bash(rm *)'] });
    const options = claudeOptions(
      { config },
      { cwd: '/project', binary: '/cli', profileDir: '/profile' },
    );
    assert.equal(options.permissionMode, permissionMode);
    assert.equal(options.allowDangerouslySkipPermissions, true);
    assert.deepEqual(options.disallowedTools, ['Bash(rm *)']);
  }
  assert.equal(permissionModes.find((m) => m.id === 'bypassPermissions')?.name, 'Omitir permisos');
  assert.equal(permissionModes.find((m) => m.id === 'dontAsk')?.name, 'Rechazar sin preguntar');
});
test('selecting bypass updates a live runtime immediately, persists only acknowledged changes, and can return to manual mode', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'desk-permissions-')));
  const m = new Manager(root, () => {});
  try {
    m.addAccount('claude');
    m.state.projects.push({ id: 'p', name: 'Test', path: root });
    const s = m.newSession('p');
    s.status = 'ready';
    const calls: string[] = [];
    let reject = false;
    m.runtimes.set(s.id, {
      buffer: '',
      sequence: 0,
      claude: {
        async setPermissionMode(mode: string) {
          if (reject) throw new Error('Policy rejected');
          calls.push(mode);
        },
        async stop() {
          m.runtimes.delete(s.id);
        },
      } as any,
    });
    assert.equal(s.config?.allowBypass, false);
    assert.deepEqual(
      await m.configure(s.id, { permissionMode: 'bypassPermissions', allowBypass: true }),
      { restart: false },
    );
    assert.deepEqual(calls, ['bypassPermissions']);
    assert.equal(s.config?.permissionMode, 'bypassPermissions');
    assert.equal(s.notice, undefined);
    assert.equal(s.status, 'ready');
    await m.configure(s.id, { permissionMode: 'default' });
    reject = true;
    await assert.rejects(
      m.configure(s.id, { permissionMode: 'bypassPermissions' }),
      /Policy rejected/,
    );
    assert.equal(s.config?.permissionMode, 'default');
    m.store.flush();
    assert.equal(new Store(root).state.sessions[0].config?.permissionMode, 'default');
    reject = false;
    await m.configure(s.id, { permissionMode: 'dontAsk' });
    m.store.flush();
    assert.equal(new Store(root).state.sessions[0].config?.permissionMode, 'dontAsk');
  } finally {
    await m.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
