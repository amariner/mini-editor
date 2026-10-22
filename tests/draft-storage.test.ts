import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftStorage } from '../src/draft-storage';

function fixture() {
  const data = new Map<string, string>();
  let unavailable = false;
  let full = false;
  const disk: Storage = {
    get length() {
      if (unavailable) throw Error('SecurityError');
      return data.size;
    },
    key(index) {
      return [...data.keys()][index] ?? null;
    },
    getItem(key) {
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      if (full) throw Error('QuotaExceededError');
      data.set(key, value);
    },
    removeItem(key) {
      if (unavailable) throw Error('SecurityError');
      data.delete(key);
    },
    clear() {
      data.clear();
    },
  };
  const memory = createDraftStorage(() => {
    if (unavailable) throw Error('SecurityError');
    return disk;
  });
  return {
    data,
    disk,
    memory,
    setFull: () => {
      full = true;
    },
    setUnavailable: () => {
      unavailable = true;
    },
  };
}

test('draft storage preserves new text across reads when quota rejects writes', () => {
  const f = fixture();
  f.data.set('text:a', 'old');
  f.data.set('text:b', 'other chat');
  f.setFull();
  f.memory.write('text:a', 'unsaved new text');
  for (let i = 0; i < 3; i++)
    assert.deepEqual(f.memory.entries('text:'), [
      ['text:a', 'unsaved new text'],
      ['text:b', 'other chat'],
    ]);
  assert.equal(f.data.get('text:a'), 'old');
});

test('draft storage keeps its last snapshot if reads fail and can still edit or delete', () => {
  const f = fixture();
  f.data.set('text:a', 'cached');
  assert.deepEqual(f.memory.entries('text:'), [['text:a', 'cached']]);
  f.setUnavailable();
  f.memory.write('text:b', 'in memory');
  assert.deepEqual(f.memory.entries('text:'), [
    ['text:a', 'cached'],
    ['text:b', 'in memory'],
  ]);
  f.memory.write('text:a', null);
  assert.deepEqual(f.memory.entries('text:'), [['text:b', 'in memory']]);
});

test('broadcast fallback shares edits and deletions between windows even when disk is stale', () => {
  const f = fixture();
  f.data.set('text:a', 'old');
  f.memory.receive('text:a', 'from another window');
  f.memory.receive('text:b', 'second chat');
  assert.deepEqual(f.memory.entries('text:'), [
    ['text:a', 'from another window'],
    ['text:b', 'second chat'],
  ]);
  f.memory.receive('text:a', null);
  assert.deepEqual(f.memory.entries('text:'), [['text:b', 'second chat']]);
  f.memory.receive('text:a', 'later update');
  assert.deepEqual(f.memory.entries('text:'), [
    ['text:a', 'later update'],
    ['text:b', 'second chat'],
  ]);
});

test('a persisted cross-window edit stops overriding future disk changes', () => {
  const f = fixture();
  f.data.set('text:a', 'remote');
  f.memory.receive('text:a', 'remote');
  assert.deepEqual(f.memory.entries('text:'), [['text:a', 'remote']]);
  f.data.set('text:a', 'newer');
  assert.deepEqual(f.memory.entries('text:'), [['text:a', 'newer']]);
});

test('delayed storage events cannot restore old data or erase a newer in-memory edit', () => {
  const f = fixture();
  f.data.set('text:a', 'already persisted before the local edit');
  f.setFull();
  f.memory.write('text:a', 'newer local fallback');
  // The event for the older write arrives after the failed local edit.
  f.memory.refresh('text:a');
  assert.deepEqual(f.memory.entries('text:'), [['text:a', 'newer local fallback']]);
  // A subsequent successful remote edit changes the actual persisted value.
  f.data.set('text:a', 'newest remote edit');
  f.memory.refresh('text:a');
  assert.deepEqual(f.memory.entries('text:'), [['text:a', 'newest remote edit']]);
  // Another delayed event reads that latest value, never its historical event.newValue.
  f.memory.refresh('text:a');
  assert.deepEqual(f.memory.entries('text:'), [['text:a', 'newest remote edit']]);
});

test('attachment lifetime and text drafts remain independent during storage failure', () => {
  const f = fixture();
  f.setUnavailable();
  f.memory.write('text:a', 'keep');
  f.memory.write('images:a', 'expired');
  f.memory.write('lifetime', 'new-instance');
  f.memory.write('images:a', null);
  assert.deepEqual(f.memory.entries('text:'), [['text:a', 'keep']]);
  assert.deepEqual(f.memory.entries('images:'), []);
  assert.deepEqual(f.memory.entries('lifetime'), [['lifetime', 'new-instance']]);
});
