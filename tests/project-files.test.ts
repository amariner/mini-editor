import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  opensAsText,
  projectFiles,
  resolveProjectPath,
  scorePath,
  searchProjectFiles,
} from '../electron/project-files';
import { actionSchema } from '../electron/core';

const temp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desk-files-')));

test('rutas del chat: relativas, absolutas, con línea y nunca fuera del proyecto', async () => {
  const root = temp();
  const outside = temp();
  try {
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'guía.md'), '# hola');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    const file = path.join(root, 'docs', 'guía.md');
    assert.deepEqual(await resolveProjectPath(root, 'docs/guía.md'), {
      path: file,
      directory: false,
    });
    assert.deepEqual(await resolveProjectPath(root, `${file}:12:3`), {
      path: file,
      directory: false,
    });
    assert.deepEqual(await resolveProjectPath(root, 'docs/guía.md#L4-L9'), {
      path: file,
      directory: false,
    });
    assert.deepEqual(await resolveProjectPath(root, 'docs'), {
      path: path.join(root, 'docs'),
      directory: true,
    });
    await assert.rejects(resolveProjectPath(root, '../' + path.basename(outside) + '/secret.txt'));
    await assert.rejects(resolveProjectPath(root, path.join(outside, 'secret.txt')));
    await assert.rejects(resolveProjectPath(root, 'link.txt'));
    await assert.rejects(resolveProjectPath(root, '~/secret.txt'));
    assert.equal(opensAsText('src/a.tsx'), true);
    assert.equal(opensAsText('Makefile'), true);
    assert.equal(opensAsText('run.command'), false);
    assert.equal(opensAsText('Tool.app'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
test('búsqueda de archivos para @: Git respeta .gitignore y el orden favorece el nombre', async () => {
  const root = temp();
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'node_modules'));
    for (const f of [
      'src/chat.tsx',
      'src/markdown.tsx',
      'README.md',
      'node_modules/x.js',
      'ignored.log',
    ])
      fs.writeFileSync(path.join(root, f), '');
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n*.log\n');
    const files = await projectFiles(root);
    assert.ok(files.includes('src/chat.tsx'));
    assert.ok(!files.some((f) => f.startsWith('node_modules') || f.endsWith('.log')));
    assert.deepEqual((await searchProjectFiles(root, 'chat')).slice(0, 1), ['src/chat.tsx']);
    assert.ok(scorePath('src/chat.tsx', 'chat') > scorePath('docs/cheat-sheet.md', 'chat'));
    assert.equal(scorePath('src/chat.tsx', 'zzz'), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('IPC valida las acciones nuevas', () => {
  assert.equal(
    actionSchema.safeParse({ type: 'openPath', projectId: 'p', path: 'a.md' }).success,
    true,
  );
  assert.equal(
    actionSchema.safeParse({ type: 'openPath', projectId: 'p', path: '' }).success,
    false,
  );
  assert.equal(
    actionSchema.safeParse({ type: 'listFiles', projectId: 'p', query: 'x'.repeat(301) }).success,
    false,
  );
});
