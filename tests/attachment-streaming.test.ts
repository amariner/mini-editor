import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Attachments } from '../electron/attachments';

test('adjuntar y verificar documentos grandes no los carga enteros en memoria', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-attachment-stream-'));
  const source = path.join(root, 'large.csv');
  const size = 32 * 1024 * 1024;
  try {
    await fs.writeFile(source, 'a,b\n');
    await fs.truncate(source, size);
    await fs.chmod(source, 0o644);
    const attachments = new Attachments(path.join(root, 'private'), () => {
      throw new Error('No deben generarse miniaturas para documentos.');
    });
    t.mock.method(fs, 'readFile', () => {
      throw new Error('No debe leerse el documento completo.');
    });
    const [attachment] = await attachments.add('chat', [source]);
    const [prepared] = await attachments.resolve('chat', [attachment.id]);
    assert.equal(attachment.size, size);
    assert.equal(prepared.data, '');
    assert.equal((await fs.stat(prepared.path)).size, size);
    assert.equal((await fs.stat(prepared.path)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(source)).mode & 0o777, 0o644);
    const copy = await fs.open(prepared.path, 'r+');
    try {
      await copy.write(Buffer.from('x,y\n'), 0, 4, 0);
    } finally {
      await copy.close();
    }
    await assert.rejects(attachments.resolve('chat', [attachment.id]), /ha cambiado/);
    await attachments.cleanup();
    assert.deepEqual(await fs.readdir(path.join(root, 'private')), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('un archivo inválido rechaza el lote local antes de guardar ninguna copia', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-attachment-invalid-'));
  const directory = path.join(root, 'private');
  try {
    await fs.writeFile(path.join(root, 'valid.txt'), 'Documento válido');
    await fs.writeFile(path.join(root, 'invalid.pdf'), 'No es un PDF');
    const attachments = new Attachments(directory, () => '');
    await assert.rejects(
      attachments.add('chat', [path.join(root, 'valid.txt'), path.join(root, 'invalid.pdf')]),
      /PDF válido/,
    );
    await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
