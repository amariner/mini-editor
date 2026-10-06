import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SESSION_TABS, openSessionTab } from '../src/session-tabs';
import type { Session } from '../src/shared';
const session = (
  id: string,
  status: Session['status'] = 'stopped',
  profile: Session['profile'] = 'codex',
): Session => ({ id, projectId: 'p', profile, title: id, status, messages: [], approvals: [] });
test('limits tabs by least recent inactive session without deleting conversation data', () => {
  const sessions = Array.from({ length: 7 }, (_, i) => session(String(i)));
  let ids: string[] = [];
  for (const s of sessions.slice(0, 5)) ids = openSessionTab(ids, s, sessions);
  ids = openSessionTab(ids, sessions[0], sessions);
  ids = openSessionTab(ids, sessions[5], sessions);
  assert.equal(ids.length, MAX_SESSION_TABS);
  assert.ok(ids.includes('0'));
  assert.ok(!ids.includes('1'));
  assert.equal(sessions.length, 7);
});
test('never evicts a running agent; filters deleted and unrelated session refs', () => {
  const sessions = [
    session('0', 'working'),
    ...['1', '2', '3', '4', '5'].map((id) => session(id)),
    session('other', 'stopped', 'claude-1'),
  ];
  const ids = openSessionTab(['missing', 'other', '0', '1', '2', '3', '4'], sessions[5], sessions);
  assert.deepEqual(ids, ['0', '2', '3', '4', '5']);
});
