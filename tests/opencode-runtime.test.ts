import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { OpenCodeRuntime, openCodeConfig } from '../electron/opencode-runtime';
import type { OpenCodeService } from '../electron/opencode';
import type { Session, ModelInfo } from '../src/shared';
const free: ModelInfo = {
  value: 'free-model',
  displayName: 'Free',
  description: '',
  free: true,
  tools: true,
};
const paid: ModelInfo = {
  value: 'paid-model',
  displayName: 'Paid',
  description: '',
  free: false,
  tools: true,
};
async function until(fn: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('State timeout');
}
async function fixture() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desk-acp-test-')));
  const s: Session = {
    id: 'chat-1',
    projectId: 'p',
    profile: 'opencode-1',
    title: 'Test',
    status: 'stopped',
    messages: [],
    approvals: [],
    providerConfig: { model: free.value },
  };
  const api = { key: async () => 'test-access' } as Pick<OpenCodeService, 'key'>;
  const runtime = new OpenCodeRuntime(
    s,
    dir,
    dir,
    api,
    () => {},
    async () => [free, paid],
    () => ({}),
    path.resolve('tests/fixtures/opencode-acp.mjs'),
  );
  await runtime.start();
  return {
    dir,
    s,
    runtime,
    cleanup: async () => {
      await runtime.stop();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
test('official ACP streams replies, pins explicit models, and stores no token in its config', async () => {
  const f = await fixture();
  try {
    await f.runtime.send('hello', []);
    await until(() => f.s.status === 'ready');
    assert.equal(f.s.messages.at(-1)?.text, 'OK');
    assert.equal(f.s.stats?.inputTokens, 10);
    const config = await fs.readFile(
      path.join(f.dir, 'profiles/opencode-1/official/chat-1/config/opencode/opencode.json'),
      'utf8',
    );
    assert.ok(!config.includes('test-access'));
    assert.equal(JSON.parse(config).permissions[0].effect, 'ask');
    f.s.providerConfig = { model: paid.value };
    await f.runtime.send('hello again', []);
    await until(() => f.s.status === 'ready');
    assert.equal(f.s.info?.model, paid.value);
    assert.equal(
      openCodeConfig('opencode/paid-model').agents.compaction.model,
      'opencode/paid-model',
    );
    f.s.providerConfig = { model: 'unselected-model' };
    await assert.rejects(f.runtime.send('no', []), /Selecciona/);
  } finally {
    await f.cleanup();
  }
});
test('ACP asks before writes; rejection and cancellation prevent execution', async () => {
  const f = await fixture();
  try {
    await f.runtime.send('write file', []);
    await until(() => f.s.status === 'waiting');
    await assert.rejects(fs.access(path.join(f.dir, 'test.txt')));
    f.runtime.approve(f.s.approvals[0].id, 'decline');
    await until(() => f.s.status === 'ready');
    await assert.rejects(fs.access(path.join(f.dir, 'test.txt')));
    await f.runtime.send('write file', []);
    await until(() => f.s.status === 'waiting');
    await f.runtime.interrupt();
    await until(() => f.s.status === 'ready');
    await assert.rejects(fs.access(path.join(f.dir, 'test.txt')));
    assert.equal(f.s.approvals.length, 0);
    await f.runtime.send('write file', []);
    await until(() => f.s.status === 'waiting');
    f.runtime.approve(f.s.approvals[0].id, 'accept');
    await until(() => f.s.status === 'ready');
    assert.equal(await fs.readFile(path.join(f.dir, 'test.txt'), 'utf8'), 'approved');
    await f.runtime.send('slow', []);
    await until(() => f.s.status === 'working');
    await f.runtime.interrupt();
    await until(() => f.s.status === 'ready');
  } finally {
    await f.cleanup();
  }
});
