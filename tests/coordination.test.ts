import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Coordinator, isCoordinationApproval } from '../electron/coordination';
import type { Session } from '../src/shared';
const session = (id: string, profile: Session['profile']): Session => ({
  id,
  profile,
  projectId: 'p',
  title: id,
  status: 'ready',
  messages: [],
  approvals: [],
});
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'desk-coordination-')));
  fs.mkdirSync(path.join(root, 'src'));
  fs.symlinkSync(path.join(root, 'src'), path.join(root, 'alias'));
  const c = new Coordinator();
  c.register(session('a', 'claude-1'), root);
  c.register(session('b', 'codex'), root);
  return {
    c,
    root,
    clean: async () => {
      await c.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
test('concurrent accounts claim different files; overlapping claims are atomic and cannot be released by peers', async () => {
  const { c, clean } = fixture();
  try {
    assert.equal(
      c.call('a', { operation: 'claim', paths: ['src/a.ts'], summary: 'Implementa A' }).ok,
      true,
    );
    assert.equal(c.call('b', { operation: 'claim', paths: ['src/b.ts'] }).ok, true);
    assert.equal(c.call('b', { operation: 'claim', paths: ['other.ts', 'src'] }).ok, false);
    assert.deepEqual(c.snapshot().find((p) => p.sessionId === 'b')?.paths, ['src/b.ts']);
    c.call('b', { operation: 'release', paths: ['src/a.ts'] });
    assert.equal(c.call('b', { operation: 'claim', paths: ['alias/a.ts'] }).ok, false);
    c.unregister('a');
    assert.equal(c.call('b', { operation: 'claim', paths: ['src'] }).ok, true);
  } finally {
    await clean();
  }
});
test('coordination rejects traversal, outside symlinks, invalid actions and stopped participants', async () => {
  const { c, root, clean } = fixture();
  try {
    fs.symlinkSync(os.tmpdir(), path.join(root, 'outside'));
    for (const file of ['../escape', 'outside/escape'])
      assert.throws(() => c.call('a', { operation: 'claim', paths: [file] }));
    assert.throws(() => c.call('a', { operation: 'delete', paths: ['.'] }));
    assert.throws(() => c.call('a', { operation: 'claim', paths: [] }));
    c.unregister('a');
    assert.throws(() => c.call('a', { operation: 'status' }));
  } finally {
    await clean();
  }
});
test('local coordination endpoint requires its per-session capability and invalidates it on exit', async () => {
  const { c, clean } = fixture();
  try {
    const conf = await c.config('a');
    const url = conf.env.AGENT_DESK_COORDINATION_URL;
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 403);
    const headers = { Authorization: `Bearer ${conf.env.AGENT_DESK_COORDINATION_TOKEN}` };
    assert.equal(
      (await fetch(url, { method: 'POST', headers, body: JSON.stringify({ operation: 'status' }) }))
        .status,
      200,
    );
    c.unregister('a');
    assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 403);
  } finally {
    await clean();
  }
});

test('solo la herramienta interna de coordinación se autoriza automáticamente', () => {
  const p = {
    serverName: 'agent_desk',
    mode: 'form',
    message: 'Allow tool "coordinate"?',
    _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: { operation: 'status' } },
    requestedSchema: { type: 'object', properties: {} },
  };
  assert.equal(isCoordinationApproval('mcpServer/elicitation/request', p), true);
  assert.equal(isCoordinationApproval('item/commandExecution/requestApproval', p), false);
  assert.equal(
    isCoordinationApproval('mcpServer/elicitation/request', { ...p, serverName: 'other' }),
    false,
  );
  assert.equal(
    isCoordinationApproval('mcpServer/elicitation/request', {
      ...p,
      message: 'Allow tool "delete"?',
    }),
    false,
  );
  assert.equal(
    isCoordinationApproval('mcpServer/elicitation/request', {
      ...p,
      requestedSchema: { type: 'object', properties: { password: { type: 'string' } } },
    }),
    false,
  );
  assert.equal(
    isCoordinationApproval('mcpServer/elicitation/request', {
      ...p,
      _meta: { ...p._meta, tool_params: { operation: 'exec' } },
    }),
    false,
  );
});
