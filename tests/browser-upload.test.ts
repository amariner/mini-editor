import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { browserUploadPaths } from '../electron/browser-upload';

test('browser uploads resolve project files and clear selections without reading file contents', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-upload-paths-'));
  try {
    await fs.writeFile(path.join(root, 'report.csv'), 'month,total\nOct,42');
    const files = await browserUploadPaths(['report.csv'], root);
    assert.deepEqual(files, [
      { path: await fs.realpath(path.join(root, 'report.csv')), name: 'report.csv', size: 18 },
    ]);
    assert.deepEqual(await browserUploadPaths([], root), []);
    await assert.rejects(browserUploadPaths(['.'], root), /fuera del proyecto|carpetas/);
    await assert.rejects(browserUploadPaths(['missing.pdf'], root), /No se encuentra/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('automated uploads reject private files and paths escaping the project through symlinks', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-upload-isolation-'));
  const root = path.join(temp, 'project');
  await fs.mkdir(root);
  try {
    const external = path.join(temp, 'outside.txt');
    await fs.writeFile(external, 'outside');
    await fs.writeFile(path.join(root, '.env'), 'secret');
    await fs.writeFile(path.join(root, 'private.pem'), 'secret');
    await fs.symlink(external, path.join(root, 'linked.txt'));
    await fs.symlink(path.join(root, '.env'), path.join(root, 'renamed.txt'));
    for (const file of ['../outside.txt', external, 'linked.txt'])
      await assert.rejects(browserUploadPaths([file], root), /fuera del proyecto/);
    for (const file of ['.env', 'private.pem', 'renamed.txt'])
      await assert.rejects(browserUploadPaths([file], root), /credenciales/);
    assert.equal(
      (await browserUploadPaths([external], undefined, { userSelected: true }))[0].name,
      'outside.txt',
    );
    await assert.rejects(browserUploadPaths([external]), /proyecto/);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
