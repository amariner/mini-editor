import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  Attachments,
  claudeImageContent,
  codexImageContent,
  imageType,
} from '../electron/attachments';
import { actionSchema } from '../electron/core';
import { Store } from '../electron/store';
test('adjuntos de diálogo quedan aislados por chat y viajan con los formatos oficiales', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-attachment-test-'));
  try {
    const file = path.join(root, 'captura.png');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VAAAAABJRU5ErkJggg==',
      'base64',
    );
    await fs.writeFile(file, png);
    const attachments = new Attachments(
      path.join(root, 'private'),
      () => `data:image/png;base64,${png.toString('base64')}`,
    );
    const refs = await attachments.add('chat1', [file]);
    const prepared = await attachments.resolve('chat1', [refs[0].id]);
    assert.ok(!('path' in refs[0]));
    await assert.rejects(attachments.resolve('chat2', [refs[0].id]), /no pertenece/);
    await assert.rejects(attachments.resolve('chat1', ['../../secret']), /no pertenece/);
    assert.equal(
      actionSchema.safeParse({
        type: 'send',
        sessionId: 'chat1',
        text: '',
        attachmentIds: [refs[0].id],
      }).success,
      true,
    );
    assert.equal(
      actionSchema.safeParse({
        type: 'send',
        sessionId: 'chat1',
        text: '',
        attachmentIds: ['/etc/passwd'],
      }).success,
      false,
    );
    const cc = claudeImageContent('', prepared) as any[];
    assert.equal(cc[0].source.media_type, 'image/png');
    assert.equal(cc[0].source.data, png.toString('base64'));
    const cx = codexImageContent('Revisa', prepared) as any[];
    assert.equal(cx[1].type, 'localImage');
    assert.ok(cx[1].path.startsWith(path.join(root, 'private')));
    assert.deepEqual(await fs.readFile(file), png);
    await assert.rejects(attachments.add('chat1', Array(5).fill(file)), /hasta 4/);
    await fs.writeFile(file, Buffer.alloc(5 * 1024 * 1024 + 1));
    await assert.rejects(attachments.add('chat1', [file]), /5 MB/);
    assert.throws(() => imageType(Buffer.from('<svg>')), /Formato/);
    const copy = prepared[0].path;
    await attachments.discard('chat1', [refs[0].id]);
    await assert.rejects(fs.stat(copy));
    await fs.writeFile(file, png);
    const sent = await attachments.add('chat1', [file]);
    const sentPath = (await attachments.resolve('chat1', [sent[0].id]))[0].path;
    attachments.markUsed([sent[0].id]);
    await attachments.cleanup();
    assert.equal((await fs.stat(sentPath)).isFile(), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('imágenes soltadas: tipo real, lote atómico, tamaño, aislamiento y miniaturas persistidas', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-dropped-images-'));
  try {
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VAAAAABJRU5ErkJggg==';
    const directory = path.join(root, 'images');
    const attachments = new Attachments(directory, () => `data:image/png;base64,${png}`);
    await assert.rejects(
      attachments.addData('s', [
        { name: 'ok.png', data: png },
        { name: 'false.png', data: Buffer.from('not image').toString('base64') },
      ]),
      /Formato/,
    );
    await assert.rejects(fs.stat(directory));
    await assert.rejects(
      attachments.addData('s', [
        { name: 'huge.png', data: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') },
      ]),
      /5 MB/,
    );
    await assert.rejects(
      attachments.addData('s', [{ name: 'bad.png', data: '!!' }]),
      /no son válidos/,
    );
    const images = await attachments.addData('s', [{ name: '../photo.png', data: png }]);
    assert.equal(images[0].name, 'photo.png');
    assert.equal((await attachments.resolve('s', [images[0].id]))[0].mediaType, 'image/png');
    await assert.rejects(attachments.resolve('other', [images[0].id]), /no pertenece/);
    assert.equal(
      actionSchema.safeParse({
        type: 'dropImages',
        sessionId: 's',
        images: [{ name: 'photo.png', path: '/etc/passwd' }],
      }).success,
      false,
    );
    const store = new Store(root);
    store.state.profiles = [{ id: 'codex', kind: 'codex', name: 'Test' }];
    store.state.sessions = [
      {
        id: 's',
        projectId: 'p',
        profile: 'codex',
        title: 'Test',
        status: 'stopped',
        approvals: [],
        messages: [{ id: 'm', role: 'user', text: '', attachments: images }],
      },
    ];
    store.flush();
    assert.deepEqual(new Store(root).state.sessions[0].messages[0].attachments, images);
    await attachments.discard('s', [images[0].id]);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
