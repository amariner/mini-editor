import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  Attachments,
  claudeAttachmentContent,
  codexAttachmentContent,
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
    const cc = claudeAttachmentContent('', prepared) as any[];
    assert.equal(cc[0].source.media_type, 'image/png');
    assert.equal(cc[0].source.data, png.toString('base64'));
    const cx = codexAttachmentContent('Revisa', prepared) as any[];
    assert.equal(cx[1].type, 'localImage');
    assert.ok(cx[1].path.startsWith(path.join(root, 'private')));
    assert.deepEqual(await fs.readFile(file), png);
    const many = await attachments.add('chat1', Array(12).fill(file));
    assert.equal(
      (
        await attachments.resolve(
          'chat1',
          many.map((f) => f.id),
        )
      ).length,
      12,
    );
    await attachments.discard(
      'chat1',
      many.map((f) => f.id),
    );
    const largePng = Buffer.concat([png, Buffer.alloc(6 * 1024 * 1024)]);
    await fs.writeFile(file, largePng);
    const largeRefs = await attachments.add('chat1', [file]);
    assert.equal(
      (await attachments.resolve('chat1', [largeRefs[0].id]))[0].data,
      largePng.toString('base64'),
    );
    await attachments.discard(
      'chat1',
      largeRefs.map((f) => f.id),
    );
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
    const largePng = Buffer.concat([
      Buffer.from(png, 'base64'),
      Buffer.alloc(6 * 1024 * 1024),
    ]).toString('base64');
    const largeRefs = await attachments.addData('s', [{ name: 'huge.png', data: largePng }]);
    assert.equal((await attachments.resolve('s', [largeRefs[0].id]))[0].data, largePng);
    await attachments.discard(
      's',
      largeRefs.map((f) => f.id),
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

test('documentos, hojas de cálculo y código se copian íntegros y se envían como archivos locales', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-documents-'));
  try {
    const directory = path.join(root, 'private');
    const attachments = new Attachments(directory, () => {
      throw Error('No debe generar miniaturas de documentos');
    });
    const originals = [
      { name: 'informe.pdf', data: Buffer.from('%PDF-1.4\n%%EOF') },
      { name: 'ventas.csv', data: Buffer.from('producto,importe\ncafé,12\n') },
      { name: 'documento.docx', data: Buffer.from('PK\x03\x04Office archive') },
      { name: 'datos.xlsx', data: Buffer.from('PK\x03\x04Excel archive') },
      { name: 'slides.pptx', data: Buffer.from('PK\x03\x04PowerPoint archive') },
      { name: 'script.py', data: Buffer.from('print("hola")') },
      { name: 'README.md', data: Buffer.from('# Documento') },
      { name: 'datos.json', data: Buffer.from('{"ok":true}') },
      { name: 'backup.zip', data: Buffer.from('PK\x03\x04archive') },
      { name: 'vacio.txt', data: Buffer.alloc(0) },
      { name: 'extra.log', data: Buffer.from('log') },
    ];
    for (const file of originals) await fs.writeFile(path.join(root, file.name), file.data);
    const refs = await attachments.add(
      'chat',
      originals.map((f) => path.join(root, f.name)),
    );
    assert.equal(refs.length, 11);
    assert.equal(
      actionSchema.safeParse({
        type: 'send',
        sessionId: 'chat',
        text: '',
        attachmentIds: refs.map((f) => f.id),
      }).success,
      true,
    );
    assert.equal(
      actionSchema.safeParse({
        type: 'discardImages',
        sessionId: 'chat',
        attachmentIds: refs.map((f) => f.id),
      }).success,
      true,
    );
    assert.equal(
      actionSchema.safeParse({
        type: 'dropImages',
        sessionId: 'chat',
        images: originals.map((f) => ({ name: f.name, data: f.data.toString('base64') })),
      }).success,
      true,
    );
    assert.equal(refs[0].mediaType, 'application/pdf');
    assert.equal(refs[1].mediaType, 'text/csv');
    assert.ok(refs.every((f) => !f.preview && !('path' in f)));
    const prepared = await attachments.resolve(
      'chat',
      refs.map((f) => f.id),
    );
    for (const [index, file] of prepared.entries()) {
      assert.equal(path.basename(file.path), originals[index].name);
      assert.deepEqual(await fs.readFile(file.path), originals[index].data);
      assert.equal(file.data, '');
    }
    for (const content of [
      claudeAttachmentContent('Resume', prepared),
      codexAttachmentContent('', prepared),
    ] as any[][]) {
      assert.equal(content.length, 1);
      assert.equal(content[0].type, 'text');
      for (const file of prepared) assert.ok(content[0].text.includes(file.path));
    }
    await assert.rejects(attachments.resolve('otro', [refs[0].id]), /no pertenece/);
    await assert.rejects(attachments.resolve('chat', [refs[0].id, refs[0].id]), /no válidos/);
    const store = new Store(root);
    store.state.profiles = [{ id: 'codex', kind: 'codex', name: 'Test' }];
    store.state.sessions = [
      {
        id: 'chat',
        projectId: 'p',
        profile: 'codex',
        title: 'Files',
        status: 'stopped',
        approvals: [],
        messages: [{ id: 'u', role: 'user', text: '', attachments: refs }],
      },
    ];
    store.flush();
    assert.deepEqual(new Store(root).state.sessions[0].messages[0].attachments, refs);
    attachments.markUsed(refs.map((f) => f.id));
    await attachments.cleanup();
    // A fresh process deletes copies using persisted metadata, including legacy images.
    const legacy = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await fs.writeFile(path.join(directory, `${legacy}.png`), 'old');
    const restarted = new Attachments(directory, () => '');
    await restarted.removeSessions([
      { id: 'chat', messages: [{ attachments: [...refs, { id: legacy, name: 'old.png' }] }] },
    ]);
    assert.deepEqual(await fs.readdir(directory), []);
    for (const file of originals)
      assert.deepEqual(await fs.readFile(path.join(root, file.name)), file.data);
    await assert.rejects(restarted.addData('chat', [{ name: 'new.txt', data: '' }]), /eliminado/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('archivos sobre 25 MB y total sobre 50 MB, lote atómico e integridad de copias', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-file-limits-'));
  try {
    const attachments = new Attachments(path.join(root, 'private'), () => '');
    await assert.rejects(
      attachments.addData('s', [
        { name: 'good.csv', data: Buffer.from('a,b').toString('base64') },
        { name: 'bad.pdf', data: Buffer.from('not pdf').toString('base64') },
      ]),
      /PDF válido/,
    );
    await assert.rejects(fs.stat(path.join(root, 'private')));
    await assert.rejects(attachments.add('s', [root]), /carpetas/);
    const large = path.join(root, 'large.csv');
    await fs.writeFile(large, '');
    const size = 26 * 1024 * 1024;
    await fs.truncate(large, size);
    const refs = await attachments.add('s', [large, large]);
    const prepared = await attachments.resolve(
      's',
      refs.map((f) => f.id),
    );
    assert.equal(prepared.length, 2);
    assert.equal(
      prepared.reduce((total, f) => total + f.attachment.size!, 0),
      2 * size,
    );
    // Pasted/dropped files cross the same former per-file/base64 limit.
    const payload = { name: 'large.csv', data: (await fs.readFile(large)).toString('base64') };
    assert.equal(
      actionSchema.safeParse({ type: 'dropImages', sessionId: 's', images: [payload] }).success,
      true,
    );
    const dropped = await attachments.addData('s', [payload]);
    assert.equal((await attachments.resolve('s', [dropped[0].id]))[0].attachment.size, size);
    await attachments.discard(
      's',
      refs.map((f) => f.id),
    );
    const copied = await attachments.addData('s', [
      { name: '..\\ventas.csv', data: Buffer.from('a,b').toString('base64') },
    ]);
    assert.equal(copied[0].name, 'ventas.csv');
    const resolved = (await attachments.resolve('s', [copied[0].id]))[0];
    await fs.writeFile(resolved.path, 'x,y'); // Same size, different contents.
    await assert.rejects(attachments.resolve('s', [copied[0].id]), /ha cambiado/);
    await attachments.cleanup();
    assert.deepEqual(await fs.readdir(path.join(root, 'private')), []);
    assert.equal(
      actionSchema.safeParse({
        type: 'dropImages',
        sessionId: 's',
        images: [{ name: 'empty.txt', data: '' }],
      }).success,
      true,
    );
    assert.equal(
      actionSchema.safeParse({
        type: 'send',
        sessionId: 's',
        text: '',
        attachmentIds: refs.map((f) => f.id).concat(copied[0].id),
      }).success,
      true,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
