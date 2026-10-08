import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Manager } from '../electron/manager';
import { sessionAccountLocked } from '../src/session-tabs';

const models = [
  {
    value: 'fixture-model',
    displayName: 'Fixture',
    description: '',
    isDefault: true,
    supportedEffortLevels: ['low', 'high'],
  },
];
async function fixture(run: (m: Manager) => Promise<void>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'desk-prechat-')));
  const m = new Manager(root, () => {});
  m.addAccount('claude');
  m.addAccount('codex');
  m.state.projects.push({ id: 'p', name: 'Fixture', path: root });
  try {
    await run(m);
  } finally {
    await m.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test('models and reasoning are configurable before starting a chat without locking its account or keeping an agent alive', () =>
  fixture(async (m) => {
    m.accounts.readModels = async () => models;
    for (const profile of ['claude-1', 'codex'] as const) {
      const s = m.newSession('p', profile);
      const before = s.reference;
      await m.refreshModels(s.id);
      if (profile === 'codex')
        await m.configureCodex(s.id, { model: 'fixture-model', effort: 'high' });
      else await m.configure(s.id, { model: 'fixture-model', effort: 'high' });
      assert.equal(s.status, 'stopped');
      assert.equal(s.reference, before);
      assert.equal(s.messages.length, 0);
      assert.equal(sessionAccountLocked(s), false);
      assert.equal(m.runtimes.size, 0);
      const sibling = m.newSession('p', profile);
      assert.deepEqual(sibling.info?.models, models);
      assert.notEqual(sibling.info?.models, s.info?.models);
    }
  }));
test('catalog requests coalesce and cancel on account switch/removal; late results cannot replace the new account', () =>
  fixture(async (m) => {
    let calls = 0;
    m.accounts.readModels = async (_profile, signal) => {
      calls++;
      return new Promise((resolve) =>
        signal.addEventListener('abort', () => resolve(models), { once: true }),
      );
    };
    const s = m.newSession('p', 'claude-1');
    const first = m.refreshModels(s.id),
      duplicate = m.refreshModels(s.id);
    await Promise.resolve();
    await m.changeSessionAccount(s.id, 'codex');
    await Promise.all([first, duplicate]);
    assert.equal(calls, 1);
    assert.equal(m.session(s.id).info, undefined);
    const next = m.refreshModels(s.id);
    await Promise.resolve();
    await m.removeProject('p');
    await next;
    assert.equal(m.state.sessions.length, 0);
    assert.equal(m.runtimes.size, 0);
  }));
