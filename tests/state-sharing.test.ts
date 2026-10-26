import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileSnapshot } from '../src/state-sharing';
import { currentActivity } from '../src/conversation';
import type { Message, Snapshot } from '../src/shared';

const fixture = (): Snapshot => ({
  dataDir: '/tmp/agent-desk-performance-test',
  projects: [{ id: 'p', name: 'Project', path: '/tmp/project' }],
  sessions: ['first', 'second'].map((id) => ({
    id,
    projectId: 'p',
    profile: 'claude-1',
    title: id,
    status: 'ready',
    approvals: [],
    messages: [
      { id: 'user', role: 'user', text: 'Review' },
      {
        id: 'answer',
        role: 'assistant',
        text: '',
        blocks: [
          {
            type: 'tool_use',
            id: 'read',
            name: 'Read',
            input: { file_path: '/tmp/project/a.ts' },
            done: true,
            result: 'data',
          },
          { type: 'text', text: 'Reviewed', final: true },
        ],
      },
    ],
  })),
  tools: {},
});

test('identical IPC snapshots retain identity and neither input is mutated', () => {
  const previous = fixture();
  const incoming = structuredClone(previous);
  const original = structuredClone(incoming);
  assert.equal(reconcileSnapshot(undefined, incoming), incoming);
  assert.equal(reconcileSnapshot(previous, incoming), previous);
  assert.deepEqual(incoming, original);
  assert.deepEqual(previous, original);
});

test('streaming changes invalidate only the affected message and session', () => {
  const previous = fixture();
  const incoming = structuredClone(previous);
  incoming.sessions[0].status = 'working';
  incoming.sessions[0].messages[1].blocks!.push({ type: 'text', text: 'More output' });
  const result = reconcileSnapshot(previous, incoming);
  assert.deepEqual(result, incoming);
  assert.equal(result.projects, previous.projects);
  assert.equal(result.sessions[1], previous.sessions[1]);
  assert.notEqual(result.sessions[0], previous.sessions[0]);
  assert.equal(result.sessions[0].messages[0], previous.sessions[0].messages[0]);
  assert.equal(result.sessions[0].messages[1], incoming.sessions[0].messages[1]);
  assert.equal(result.sessions[0].approvals, previous.sessions[0].approvals);
  assert.equal(previous.sessions[0].messages[1].blocks!.length, 2);
});

test('nested tool output, removed fields, reorder and deletion are preserved', () => {
  const previous = fixture();
  previous.sessions[0].error = 'old error';
  const incoming = structuredClone(previous);
  delete incoming.sessions[0].error;
  const tool = incoming.sessions[0].messages[1].blocks![0];
  if (tool.type !== 'tool_use') throw new Error('missing tool');
  tool.result = 'new data';
  tool.isError = true;
  incoming.sessions[0].messages.reverse();
  incoming.sessions.reverse();
  const result = reconcileSnapshot(previous, incoming);
  assert.deepEqual(result, incoming);
  assert.equal(result.sessions[0], previous.sessions[1]);
  assert.equal(result.sessions[1].messages[1], previous.sessions[0].messages[0]);
  assert.notEqual(result.sessions[1].messages[0], previous.sessions[0].messages[1]);
  assert.equal(Object.hasOwn(result.sessions[1], 'error'), false);
  incoming.sessions.pop();
  const deleted = reconcileSnapshot(result, incoming);
  assert.equal(deleted.sessions.length, 1);
  assert.equal(deleted.sessions[0], previous.sessions[1]);
});

test('a live activity update does not visit completed history', () => {
  const session = fixture().sessions[0];
  const old = session.messages[1];
  Object.defineProperty(old, 'blocks', {
    get() {
      throw new Error('completed history was read');
    },
  });
  session.messages.push(
    { id: 'latest-user', role: 'user', text: 'Continue' },
    { id: 'latest-answer', role: 'assistant', text: 'Working' },
  );
  session.status = 'working';
  assert.equal(currentActivity(session)?.messages.length, 1);
  assert.equal(currentActivity(session)?.id, 'latest-answer');
  session.status = 'ready';
  assert.equal(currentActivity(session), undefined);
});

test('long histories retain every unchanged message during a streamed delta', () => {
  const previous = fixture();
  previous.sessions[0].messages = Array.from({ length: 1000 }, (_, i): Message => ({
    id: `m${i}`,
    role: i % 2 ? 'assistant' : 'user',
    text: `Message ${i}`,
  }));
  const incoming = structuredClone(previous);
  incoming.sessions[0].messages.at(-1)!.text += ' streamed delta';
  const result = reconcileSnapshot(previous, incoming);
  assert.equal(
    result.sessions[0].messages.filter((message, i) => message === previous.sessions[0].messages[i])
      .length,
    999,
  );
  assert.deepEqual(result, incoming);
});
