import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { BrowserDownloads, downloadFilename } from '../electron/browser-downloads';

class Download extends EventEmitter {
  saved = '';
  received = 0;
  total = 100;
  paused = false;
  resumable = true;
  cancelled = 0;
  constructor(private filename = 'informe.pdf') {
    super();
  }
  getFilename() {
    return this.filename;
  }
  getReceivedBytes() {
    return this.received;
  }
  getTotalBytes() {
    return this.total;
  }
  getSavePath() {
    return this.saved;
  }
  setSavePath(value: string) {
    this.saved = value;
  }
  canResume() {
    return this.resumable;
  }
  isPaused() {
    return this.paused;
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  cancel() {
    this.cancelled++;
    this.emit('done', {}, 'cancelled');
  }
}

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desk-download-test-')));
  let changes = 0;
  const downloads = new BrowserDownloads(root, () => changes++);
  t.after(async () => {
    downloads.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const add = (item = new Download(), tabId = 'tab') => {
    let prevented = false;
    const state = downloads.handle(
      {
        preventDefault() {
          prevented = true;
        },
      },
      item as unknown as Electron.DownloadItem,
      undefined,
      { id: tabId, projectId: 'project', sessionId: 'chat' },
    );
    return { item, state: state!, prevented };
  };
  return {
    root,
    downloads,
    add,
    get changes() {
      return changes;
    },
  };
}

test('download filenames cannot traverse directories, hide extensions or exceed filesystem limits', () => {
  for (const name of [
    '../../secret.txt',
    '..\\secret.txt',
    '\u202eexe.pdf',
    '  .  ',
    'CON.txt',
    'é'.repeat(300) + '.pdf',
  ]) {
    const safe = downloadFilename(name);
    assert.ok(safe.length > 0);
    assert.equal(path.basename(safe), safe);
    assert.ok(!safe.includes('\\'));
    assert.ok(!/[\u202a-\u202e\u2066-\u2069]/.test(safe));
    assert.ok(Buffer.byteLength(safe) <= 220);
    assert.ok(!safe.startsWith('.'));
  }
  assert.ok(downloadFilename('é'.repeat(300) + '.pdf').endsWith('.pdf'));
  assert.equal(downloadFilename('informe mensual.pdf'), 'informe mensual.pdf');
});

test('native downloads receive unique paths and reveal only finished files belonging to their tab', async (t) => {
  const f = await fixture(t);
  const first = f.add();
  const second = f.add();
  assert.equal(first.prevented, false);
  assert.equal(first.state.projectId, 'project');
  assert.equal(first.state.sessionId, 'chat');
  assert.notEqual(first.item.saved, second.item.saved);
  assert.equal(path.basename(first.item.saved), 'informe.pdf');
  assert.ok(first.item.saved.startsWith(f.root + path.sep));
  assert.equal(first.state.path, undefined);
  await assert.rejects(f.downloads.revealPath(first.state.id, 'tab'), /termine/);
  await fs.writeFile(first.item.saved, 'contenido completo');
  first.item.emit('done', {}, 'completed');
  const completed = f.downloads.list('tab').find((item) => item.id === first.state.id)!;
  assert.equal(completed.state, 'completed');
  assert.equal(completed.receivedBytes, Buffer.byteLength('contenido completo'));
  assert.equal(await f.downloads.revealPath(first.state.id, 'tab'), first.item.saved);
  await assert.rejects(f.downloads.revealPath(first.state.id, 'other'), /pertenece/);
  assert.throws(() => f.downloads.cancel(first.state.id, 'other'), /pertenece/);
  completed.fileName = 'mutated';
  assert.equal(
    f.downloads.list('tab').find((item) => item.id === first.state.id)?.fileName,
    'informe.pdf',
  );
  await fs.unlink(first.item.saved);
  await assert.rejects(f.downloads.revealPath(first.state.id, 'tab'), /movido o eliminado/);
});

test('progress, pause, interruption, resume and cancellation retain native lifecycle', async (t) => {
  const f = await fixture(t);
  const { item, state } = f.add();
  item.received = 40;
  item.emit('updated', {}, 'progressing');
  assert.equal(f.downloads.list('tab')[0].receivedBytes, 40);
  assert.equal(f.downloads.pause(state.id, 'tab').state, 'paused');
  assert.equal(item.paused, true);
  assert.equal(f.downloads.resume(state.id, 'tab').state, 'progress');
  assert.equal(item.paused, false);
  item.emit('updated', {}, 'interrupted');
  assert.equal(f.downloads.list('tab')[0].canResume, true);
  assert.equal(f.downloads.resume(state.id, 'tab').state, 'progress');
  item.resumable = false;
  item.emit('done', {}, 'interrupted');
  assert.equal(f.downloads.list('tab')[0].canResume, false);
  assert.throws(() => f.downloads.resume(state.id, 'tab'), /puede reanudarse/);
  const other = f.add();
  assert.equal(f.downloads.cancel(other.state.id, 'tab').state, 'cancelled');
  assert.equal(other.item.cancelled, 1);
  assert.equal(other.item.listenerCount('updated'), 0);
  assert.equal(other.item.listenerCount('done'), 0);
});

test('missing completed files and unwritable destinations remain visible as interrupted downloads', async (t) => {
  const f = await fixture(t);
  const missing = f.add();
  missing.item.emit('done', {}, 'completed');
  assert.equal(f.downloads.list('tab')[0].state, 'interrupted');
  assert.equal(f.downloads.list('tab')[0].path, undefined);
  const file = path.join(f.root, 'not-a-folder');
  await fs.writeFile(file, 'original');
  const downloads = new BrowserDownloads(file, () => {});
  let prevented = false;
  const failed = downloads.handle(
    {
      preventDefault() {
        prevented = true;
      },
    },
    new Download() as unknown as Electron.DownloadItem,
    undefined,
    { id: 'tab', sessionId: '' },
  );
  assert.equal(prevented, true);
  assert.equal(failed?.state, 'interrupted');
  assert.equal(await fs.readFile(file, 'utf8'), 'original');
  downloads.close();
});

test('download reveal does not follow a substituted symlink, and app shutdown cancels active downloads', async (t) => {
  const f = await fixture(t);
  const first = f.add();
  await fs.writeFile(first.item.saved, 'download');
  first.item.emit('done', {}, 'completed');
  const other = path.join(f.root, 'other.txt');
  await fs.writeFile(other, 'other');
  await fs.unlink(first.item.saved);
  await fs.symlink(other, first.item.saved);
  await assert.rejects(f.downloads.revealPath(first.state.id, 'tab'), /movido o eliminado/);
  const active = f.add();
  f.downloads.close();
  assert.equal(active.item.cancelled, 1);
  assert.equal(active.item.listenerCount('updated'), 0);
  assert.equal(active.item.listenerCount('done'), 0);
  assert.equal(f.add().prevented, true);
});

test('history retains a bounded number of records without dropping live downloads', async (t) => {
  const f = await fixture(t);
  const live = f.add();
  for (let i = 0; i < 210; i++) {
    const download = f.add();
    download.item.cancel();
  }
  assert.equal(f.downloads.list('tab').length, 200);
  assert.ok(f.downloads.list('tab').some((item) => item.id === live.state.id));
});

test('a global downloads snapshot retains tab attribution for downloads after tab closure', async (t) => {
  const f = await fixture(t);
  const first = f.add(new Download(), 'closed-tab');
  f.add(new Download(), 'current-tab');
  assert.equal(f.downloads.list().length, 2);
  assert.equal(f.downloads.list('current-tab').length, 1);
  assert.equal(f.downloads.list('closed-tab')[0].id, first.state.id);
  assert.equal(f.downloads.cancel(first.state.id, 'closed-tab').state, 'cancelled');
});
