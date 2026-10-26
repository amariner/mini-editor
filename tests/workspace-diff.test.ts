import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkspaceDiff } from '../src/workspace-diff';

test('unified diff tracks old/new line numbers independently across hunks', () => {
  const lines = parseWorkspaceDiff(
    'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -3,3 +3,4 @@ function test\n keep\n-old\n+new\n+extra\n tail\n@@ -20 +21 @@\n-before\n+after\n',
  );
  assert.deepEqual(
    lines.filter((line) => ['added', 'removed', 'context'].includes(line.kind)),
    [
      { kind: 'context', text: 'keep', before: 3, after: 3 },
      { kind: 'removed', text: 'old', before: 4 },
      { kind: 'added', text: 'new', after: 4 },
      { kind: 'added', text: 'extra', after: 5 },
      { kind: 'context', text: 'tail', before: 5, after: 6 },
      { kind: 'removed', text: 'before', before: 20 },
      { kind: 'added', text: 'after', after: 21 },
    ],
  );
});

test('new/deleted files, missing newline markers and empty lines retain their meaning', () => {
  assert.deepEqual(
    parseWorkspaceDiff('@@ -0,0 +1,2 @@\n+\n+hello\n\\ No newline at end of file\n').slice(1),
    [
      { kind: 'added', text: '', after: 1 },
      { kind: 'added', text: 'hello', after: 2 },
      { kind: 'meta', text: '\\ No newline at end of file' },
    ],
  );
  assert.deepEqual(parseWorkspaceDiff('@@ -1 +0,0 @@\n-old\n').at(-1), {
    kind: 'removed',
    text: 'old',
    before: 1,
  });
  assert.deepEqual(parseWorkspaceDiff(''), []);
});

test('header-like source inside a hunk remains an added or removed line', () => {
  const lines = parseWorkspaceDiff('@@ -1,2 +1,2 @@\n--- old text\n+++ new text\n tail\n');
  assert.deepEqual(lines.slice(1), [
    { kind: 'removed', text: '-- old text', before: 1 },
    { kind: 'added', text: '++ new text', after: 1 },
    { kind: 'context', text: 'tail', before: 2, after: 2 },
  ]);
});
