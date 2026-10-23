import test from 'node:test';
import assert from 'node:assert/strict';
import { actionSchema } from '../electron/core';
import { floatingChatHash, floatingChatId } from '../src/floating-chat-protocol';

test('floating chat IPC validates window settings and rejects unexpected input', () => {
  const action = { type: 'floatingChat', sessionId: 'chat-1', operation: 'configure' };
  assert.ok(
    actionSchema.safeParse({ ...action, opacity: 0.5, alwaysOnTop: false, glass: true }).success,
  );
  assert.ok(actionSchema.safeParse({ ...action, opacity: 1, glassStrength: 2 }).success);
  assert.ok(actionSchema.safeParse({ ...action, opacity: 0.1 }).success);
  assert.ok(actionSchema.safeParse({ ...action, opacity: 0 }).success);
  assert.ok(actionSchema.safeParse({ ...action, opacity: 0.01 }).success);
  assert.ok(actionSchema.safeParse({ ...action, opacity: 0.25 }).success);
  for (const extra of [
    { opacity: -0.01 },
    { opacity: 1.1 },
    { opacity: NaN },
    { alwaysOnTop: 'yes' },
    { glass: 'yes' },
    { glassStrength: -1 },
    { glassStrength: 2.1 },
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
