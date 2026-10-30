import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { ClaudeRuntime } from '../electron/claude';
import type { Session } from '../src/shared';

function fixture() {
  const s: Session = {
    id: 's',
    projectId: 'p',
    profile: 'claude-1',
    title: 'Claude',
    status: 'working',
    messages: [],
    approvals: [],
  };
  const runtime = new ClaudeRuntime(
    s,
    {},
    () => {},
    async () => {},
  );
  return {
    s,
    runtime,
    ask: (tool: string, input: unknown, signal: AbortSignal) =>
      (runtime as any).ask(tool, input, { signal }),
  };
}

test('an already-cancelled Claude permission never leaves a waiting approval, including built-in browser tools', async () => {
  const f = fixture();
  const signal = AbortSignal.abort();
  for (const [tool, input] of [
    ['Bash', { command: 'echo test' }],
    ['mcp__agent_desk__browser', { action: 'list' }],
  ] as const) {
    assert.equal((await f.ask(tool, input, signal)).behavior, 'deny');
    assert.deepEqual(f.s.approvals, []);
    assert.equal(f.s.status, 'working');
  }
});

test('Claude approval listeners are removed on acceptance and cancellation', async () => {
  const f = fixture();
  for (const accept of [true, false]) {
    const controller = new AbortController();
    const result = f.ask('Bash', { command: 'echo test' }, controller.signal);
    assert.equal(f.s.status, 'waiting');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    if (accept) f.runtime.approve(f.s.approvals[0].id, 'accept');
    else controller.abort();
    assert.equal((await result).behavior, accept ? 'allow' : 'deny');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.deepEqual(f.s.approvals, []);
    assert.equal(f.s.status, 'working');
  }
});
