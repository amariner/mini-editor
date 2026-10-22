import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_ORDER_PREFIX,
  chatOrderGroup,
  moveChatInOrder,
  orderedProjectChats,
  orderSiblingChats,
  parseChatOrder,
  reconcileChatOrder,
} from '../src/chat-order';

const chat = (id: string, projectId = 'p', parentId?: string) => ({ id, projectId, parentId });
const ids = (chats: { id: string }[]) => chats.map((item) => item.id);

test('newest chats lead each sibling group while dropdowns retain the complete hierarchy', () => {
  const sessions = [
    chat('a'),
    chat('b'),
    chat('a1', 'p', 'a'),
    chat('a2', 'p', 'a'),
    chat('a21', 'p', 'a2'),
  ];
  const order = reconcileChatOrder(sessions, {});
  assert.deepEqual(
    ids(
      orderSiblingChats(
        sessions.filter((item) => !item.parentId),
        order,
      ),
    ),
    ['b', 'a'],
  );
  assert.deepEqual(ids(orderedProjectChats(sessions, 'p', order)), ['b', 'a', 'a2', 'a21', 'a1']);
  assert.deepEqual(
    sessions.map((item) => item.id),
    ['a', 'b', 'a1', 'a2', 'a21'],
  );
});

test('custom order survives reconciliation, new chats prepend and stale ids disappear', () => {
  const sessions = [chat('a'), chat('b'), chat('c')];
  const group = chatOrderGroup(sessions[0]);
  let order = reconcileChatOrder(sessions, {});
  order = moveChatInOrder(order, sessions, 'a', 'c', 'before');
  assert.deepEqual(order[group], ['a', 'c', 'b']);
  order = reconcileChatOrder([sessions[0], sessions[2], chat('new-1'), chat('new-2')], order);
  assert.deepEqual(order[group], ['new-2', 'new-1', 'a', 'c']);
});

test('reordering never reparents chats, crosses projects, or modifies adjacent sibling groups', () => {
  const sessions = [
    chat('a'),
    chat('b'),
    chat('a1', 'p', 'a'),
    chat('a2', 'q', 'a'),
    chat('b1', 'p', 'b'),
    chat('q', 'q'),
  ];
  const initial = reconcileChatOrder(sessions, {});
  assert.equal(moveChatInOrder(initial, sessions, 'a', 'q', 'before'), initial);
  assert.equal(moveChatInOrder(initial, sessions, 'a1', 'b1', 'before'), initial);
  assert.equal(moveChatInOrder(initial, sessions, 'a1', 'a', 'before'), initial);
  const moved = moveChatInOrder(initial, sessions, 'a1', 'a2', 'before');
  const group = chatOrderGroup(sessions[2]);
  assert.deepEqual(moved[group], ['a1', 'a2']);
  for (const key of Object.keys(initial)) if (key !== group) assert.equal(moved[key], initial[key]);
});

test('same position, missing targets and invalid drops are no-ops that need no storage write', () => {
  const sessions = [chat('a'), chat('b'), chat('c')];
  const initial = reconcileChatOrder(sessions, {});
  for (const [source, target, edge] of [
    ['c', 'c', 'before'],
    ['c', 'b', 'before'],
    ['b', 'c', 'after'],
    ['missing', 'a', 'after'],
    ['a', 'missing', 'before'],
  ] as const)
    assert.equal(moveChatInOrder(initial, sessions, source, target, edge), initial);
});

test('invalid persisted preferences never hide conversations or contaminate other group keys', () => {
  const group = chatOrderGroup(chat('a'));
  const order = parseChatOrder([
    [CHAT_ORDER_PREFIX + group, '["a","a","missing","b"]'],
    [CHAT_ORDER_PREFIX + '["project","q"]', '[null]'],
    [CHAT_ORDER_PREFIX + 'corrupt', '["b"]'],
    [CHAT_ORDER_PREFIX + '"__proto__"', '["b"]'],
    ['unrelated', '["b"]'],
  ]);
  assert.deepEqual(order, { [group]: ['a', 'missing', 'b'] });
  assert.deepEqual(reconcileChatOrder([chat('a'), chat('b'), chat('c')], order)[group], [
    'c',
    'a',
    'b',
  ]);
});

test('orphaned, cross-project and cyclic historical chats remain selectable without recursion loops', () => {
  const sessions = [
    chat('outside', 'q'),
    chat('orphan', 'p', 'gone'),
    chat('cross', 'p', 'outside'),
    chat('cycle-a', 'p', 'cycle-b'),
    chat('cycle-b', 'p', 'cycle-a'),
  ];
  const sorted = orderedProjectChats(sessions, 'p', reconcileChatOrder(sessions, {}));
  assert.equal(sorted.length, 4);
  assert.equal(new Set(sorted.map((item) => item.id)).size, 4);
  assert.ok(sorted.every((item) => item.projectId === 'p'));
});
