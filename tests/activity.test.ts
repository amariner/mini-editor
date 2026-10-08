import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diffCounts,
  duration,
  fileChanges,
  lineDiff,
  shortPath,
  stepFromBlock,
  stepFromMessage,
  stepsOf,
  summarize,
  unifiedCounts,
  workItems,
} from '../src/activity';
import type { Message } from '../src/shared';
const tool = (id: string, name: string, input: any, extra: any = {}) =>
  ({ type: 'tool_use', id, name, input, done: true, ...extra }) as const;

test('diff por líneas: contexto, cambios y recuento como un unified diff', () => {
  const d = lineDiff('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  assert.deepEqual(
    d.map((l) => l.type + l.text),
    [' a', '-b', '+B', ' c', ' d', '+e'],
  );
  assert.deepEqual(diffCounts(d), { added: 2, removed: 1 });
  assert.deepEqual(diffCounts(lineDiff('', 'x\ny\n')), { added: 2, removed: 0 });
  assert.deepEqual(unifiedCounts('--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n+z'), {
    added: 2,
    removed: 1,
  });
  assert.deepEqual(unifiedCounts('linea 1\nlinea 2', 'add'), { added: 2, removed: 0 });
});
test('pasos de Claude: tipo, objetivo relativo al proyecto y líneas editadas', () => {
  const root = '/proj';
  const edit = stepFromBlock(
    tool('e', 'Edit', { file_path: '/proj/src/a.ts', old_string: 'x', new_string: 'y\nz' }),
    root,
  );
  assert.equal(edit.kind, 'edit');
  assert.equal(edit.label, 'src/a.ts');
  assert.deepEqual([edit.added, edit.removed], [2, 1]);
  const bash = stepFromBlock(
    tool('b', 'Bash', { command: 'npm test\n# más', description: 'Probar' }),
    root,
  );
  assert.deepEqual([bash.kind, bash.label, bash.detail], ['command', 'npm test', 'Probar']);
  assert.equal(
    stepFromBlock(tool('m', 'mcp__github__search', { q: 'bug' }), root).label,
    'github · search',
  );
  assert.equal(
    stepFromBlock(tool('n', 'mcp__agent_desk__browser', { action: 'click' }), root).kind,
    'browser',
  );
  assert.equal(shortPath('/Users/ana/x', '/proj'), '~/x');
  assert.equal(shortPath('/proj', '/proj'), '.');
});
test('pasos de Codex: lecturas detectadas por Codex, comandos fallidos y ediciones', () => {
  const read: Message = {
    id: 'r',
    role: 'tool',
    text: '$ cat a.ts',
    tool: {
      kind: 'command',
      command: 'cat a.ts',
      status: 'completed',
      actions: [{ type: 'read', path: '/p/a.ts' }],
    },
  };
  assert.deepEqual(
    [stepFromMessage(read, '/p').kind, stepFromMessage(read, '/p').label],
    ['read', 'a.ts'],
  );
  const failed: Message = {
    id: 'f',
    role: 'tool',
    text: '$ npm test',
    tool: {
      kind: 'command',
      command: 'npm test',
      status: 'failed',
      exitCode: 1,
      durationMs: 4200,
    },
  };
  assert.deepEqual(
    [stepFromMessage(failed).error, stepFromMessage(failed).exit, stepFromMessage(failed).ms],
    [true, 1, 4200],
  );
  // grep without matches exits 1 but is not a failure.
  const quiet: Message = {
    id: 'g',
    role: 'tool',
    text: '$ grep x',
    tool: { kind: 'command', command: 'grep x', status: 'completed', exitCode: 1 },
  };
  assert.deepEqual([stepFromMessage(quiet).error, stepFromMessage(quiet).exit], [false, 1]);
  const legacy: Message = { id: 'l', role: 'tool', text: '$ ls\nsalida\ncompleted' };
  assert.deepEqual(
    [stepFromMessage(legacy).kind, stepFromMessage(legacy).label],
    ['command', 'ls'],
  );
  const created: Message = {
    id: 'c',
    role: 'tool',
    text: 'Cambios',
    tool: {
      kind: 'edit',
      status: 'completed',
      files: [{ path: '/p/n.md', kind: 'add', diff: 'uno\ndos' }],
    },
  };
  assert.deepEqual(
    [stepFromMessage(created, '/p').kind, stepFromMessage(created, '/p').added],
    ['create', 2],
  );
});
test('resumen en castellano: plurales, orden narrativo y prioridad a los cambios', () => {
  const steps = (names: string[]) =>
    names.map((name, i) =>
      stepFromBlock(
        tool(String(i), name, { file_path: `/f${i}`, command: `c${i}`, pattern: `p${i}` }),
      ),
    );
  assert.equal(summarize(steps(['Bash'])), 'Ejecutó 1 comando');
  assert.equal(
    summarize(steps(['Read', 'Read', 'Bash', 'Bash'])),
    'Leyó 2 archivos y ejecutó 2 comandos',
  );
  assert.equal(
    summarize(steps(['Read', 'Grep', 'Bash', 'Edit', 'WebFetch'])),
    'Leyó 1 archivo, ejecutó 1 comando, editó 1 archivo y más',
  );
  assert.equal(summarize(steps(['TodoWrite'])), 'Actualizó las tareas');
  assert.equal(summarize([]), '');
  assert.deepEqual(
    [duration(800), duration(83000), duration(3_720_000)],
    ['1 s', '1 min 23 s', '1 h 2 min'],
  );
});
test('archivos cambiados: agrupa por ruta, ignora fallos y respeta el orden', () => {
  const messages: Message[] = [
    {
      id: 'a',
      role: 'assistant',
      text: '',
      blocks: [
        tool('1', 'Write', { file_path: '/p/new.ts', content: 'a\nb' }),
        tool('2', 'Edit', { file_path: '/p/new.ts', old_string: 'a', new_string: 'A' }),
        tool(
          '3',
          'Edit',
          { file_path: '/p/old.ts', old_string: 'x', new_string: 'y' },
          { isError: true },
        ),
        tool(
          '4',
          'Task',
          { prompt: 'p' },
          {
            children: [
              tool('5', 'Edit', { file_path: '/p/sub.ts', old_string: '', new_string: 'z' }),
            ],
          },
        ),
      ],
    },
    {
      id: 'c',
      role: 'tool',
      text: '',
      tool: {
        kind: 'edit',
        status: 'completed',
        files: [{ path: '/p/codex.ts', kind: 'update', diff: '@@\n-a\n+b' }],
      },
    },
  ];
  assert.deepEqual(fileChanges(messages), [
    { path: '/p/new.ts', added: 3, removed: 1, created: true },
    { path: '/p/sub.ts', added: 1, removed: 0, created: false },
    { path: '/p/codex.ts', added: 1, removed: 1, created: false },
  ]);
  assert.equal(stepsOf(messages).length, 5);
  assert.deepEqual(
    workItems([
      {
        id: 'm',
        role: 'assistant',
        text: '',
        blocks: [
          { type: 'thinking', text: 'mm' },
          { type: 'text', text: ' ' },
        ],
      },
    ]).map((w) => w.type),
    ['thinking'],
  );
});
