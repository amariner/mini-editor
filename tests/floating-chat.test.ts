import test from 'node:test';
import assert from 'node:assert/strict';
import { actionSchema } from '../electron/core';
import { floatingChatHash, floatingChatId } from '../src/floating-chat-protocol';

test('floating chat IPC validates window settings and rejects unexpected input', () => {
  const action = { type: 'floatingChat', sessionId: 'chat-1', operation: 'configure' };
  assert.ok(actionSchema.safeParse({ ...action, opacity: 0.5, alwaysOnTop: false }).success);
  assert.ok(actionSchema.safeParse({ ...action, opacity: 1 }).success);
  for (const extra of [
    { opacity: 0 },
    { opacity: 0.25 },
    { opacity: 1.1 },
    { opacity: NaN },
    { alwaysOnTop: 'yes' },
    { url: 'https://example.com' },
  ])
    assert.equal(actionSchema.safeParse({ ...action, ...extra }).success, false);
  assert.equal(actionSchema.safeParse({ ...action, operation: 'navigate' }).success, false);
  assert.equal(actionSchema.safeParse({ ...action, sessionId: '' }).success, false);
});

test('floating routes preserve session IDs without permitting malformed hashes', () => {
  for (const id of ['a-b-c', 'chat with spaces', 'chat/#?=á'])
    assert.equal(floatingChatId(floatingChatHash(id)), id);
  for (const hash of ['', '#chat=', '#chat=%', '#other=one', '#chat=' + 'x'.repeat(151)])
    assert.equal(floatingChatId(hash), undefined);
});
