import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Manager } from '../electron/manager';
import { Store } from '../electron/store';
import { Attachments } from '../electron/attachments';

async function fixture(run: (m: Manager, root: string) => Promise<void>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'desk-remove-project-')));
  const m = new Manager(root, () => {});
  m.addAccount('claude');
  m.addAccount('codex');
  m.state.projects.push(
    { id: 'p', name: 'Remove', path: root },
    { id: 'keep', name: 'Keep', path: root },
  );
  fs.writeFileSync(path.join(root, 'source.txt'), 'keep source');
  try {
    await run(m, root);
  } finally {
    await m.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test('removing a project stops every live chat, frees buffers and persists deletion while preserving other projects and source', () =>
  fixture(async (m, root) => {
    const a = m.newSession('p', 'claude-1'),
      b = m.newSession('p', 'codex'),
      keep = m.newSession('keep');
    const stopped: string[] = [];
    for (const s of [a, b, keep]) {
      s.status = 'working';
      s.messages = [{ id: 'u', role: 'user', text: 'history' }];
      m.buffers.set(s.id, { data: 'buffer', sequence: 1 });
      m.runtimes.set(s.id, {
        buffer: '',
        sequence: 0,
        claude: {
          async stop() {
            stopped.push(s.id);
            m.runtimes.delete(s.id);
            s.status = 'stopped';
          },
        } as any,
      });
    }
    m.terminals.buffers.set('shell:p', { data: 'terminal buffer', sequence: 1 });
    m.terminals.buffers.set('shell:keep', { data: 'keep buffer', sequence: 1 });
    await m.removeProject('p', async (sessions) => {
      assert.deepEqual(
        sessions.map((s) => s.id),
        [a.id, b.id],
      );
      assert.equal(m.runtimes.has(a.id), false);
    });
    assert.deepEqual(stopped.sort(), [a.id, b.id].sort());
    assert.deepEqual(
      m.state.sessions.map((s) => s.id),
      [keep.id],
    );
    assert.equal(m.buffers.has(a.id), false);
    assert.equal(m.buffers.has(keep.id), true);
    assert.equal(m.terminals.buffers.has('shell:p'), false);
    assert.equal(m.terminals.buffers.has('shell:keep'), true);
    assert.equal(fs.readFileSync(path.join(root, 'source.txt'), 'utf8'), 'keep source');
    assert.deepEqual(
      new Store(root).state.sessions.map((s) => s.id),
      [keep.id],
    );
  }));
test('removal waits for an in-flight operation, blocks new work and coalesces duplicate requests', () =>
  fixture(async (m) => {
    const s = m.newSession('p');
    let finish!: () => void;
    const operation = m.exclusive(
      s.id,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    const removing = m.removeProject('p');
    assert.equal(m.removeProject('p'), removing);
    assert.throws(() => m.newSession('p'), /quitando/);
    await assert.rejects(m.send(s.id, 'cannot restart'), /quitando/);
    finish();
    await operation;
    await removing;
    assert.equal(
      m.state.projects.some((p) => p.id === 'p'),
      false,
    );
  }));
test('a failed process shutdown retains history and allows retry without deleting project files', () =>
  fixture(async (m) => {
    const s = m.newSession('p');
    s.status = 'working';
    s.messages = [{ id: 'u', role: 'user', text: 'keep until stopped' }];
    let fail = true,
      cleaned = false;
    m.runtimes.set(s.id, {
      buffer: '',
      sequence: 0,
      claude: {
        async stop() {
          if (fail) throw new Error('still running');
          m.runtimes.delete(s.id);
        },
      } as any,
    });
    await assert.rejects(
      m.removeProject('p', async () => {
        cleaned = true;
      }),
      /still running/,
    );
    assert.equal(cleaned, false);
    assert.equal(m.session(s.id).messages.length, 1);
    fail = false;
    await m.removeProject('p');
  }));
test('project deletion removes used and draft images, including restored message attachments, and preserves another chat', () =>
  fixture(async (m, root) => {
    const a = m.newSession('p'),
      b = m.newSession('keep');
    const dir = path.join(root, 'attachments');
    const attachments = new Attachments(dir, () => 'preview');
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
    const [used] = await attachments.addData(a.id, [{ name: 'used.png', data: image }]);
    const [draft] = await attachments.addData(a.id, [{ name: 'draft.png', data: image }]);
    const [keep] = await attachments.addData(b.id, [{ name: 'keep.png', data: image }]);
    attachments.markUsed([used.id]);
    a.messages = [{ id: 'u', role: 'user', text: '', attachments: [used] }];
    await m.removeProject('p', (sessions) => attachments.removeSessions(sessions));
    assert.equal(fs.existsSync(path.join(dir, used.id + '.png')), false);
    assert.equal(fs.existsSync(path.join(dir, draft.id + '.png')), false);
    assert.equal(fs.existsSync(path.join(dir, keep.id + '.png')), true);
    await assert.rejects(
      attachments.addData(a.id, [{ name: 'late.png', data: image }]),
      /eliminado/,
    );
    // After app restart only persisted message ids are needed to locate original bytes.
    const restored = new Attachments(dir, () => 'preview');
    await restored.removeSessions([{ id: b.id, messages: [{ attachments: [keep] }] }]);
    assert.deepEqual(fs.readdirSync(dir), []);
  }));
