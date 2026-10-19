import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync, lstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createWorktree,
  mergeWorktree,
  removeWorktree,
  updateWorktree,
  worktreeSettings,
  worktreeSlug,
  worktreeStatus,
} from '../electron/worktrees';
import { actionSchema, claudeArgs, claudeOptions } from '../electron/core';
import { Manager } from '../electron/manager';
import { canIsolate, isolationLocked, wantsWorktree } from '../src/isolation';
import type { Session } from '../src/shared';
const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await exec('git', args, { cwd })).stdout.trim();
async function fixture(run: (root: string, repo: string, data: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desk-worktree-')));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Agent Desk Test');
  await git(repo, 'config', 'user.email', 'test@example.invalid');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  await git(repo, 'config', 'core.hooksPath', '/dev/null');
  await fs.writeFile(path.join(repo, '.gitignore'), 'node_modules/\n');
  await fs.writeFile(path.join(repo, 'a.txt'), 'uno\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'inicio');
  try {
    await run(root, repo, path.join(root, 'data'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('crea un worktree por chat desde HEAD, enlaza node_modules y no ensucia ninguna copia', async () =>
  fixture(async (_root, repo, data) => {
    await fs.mkdir(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
    const wt = await createWorktree({
      project: repo,
      dataDir: data,
      title: 'Arreglar ñandú',
      id: 'abc12345-x',
    });
    assert.equal(wt.branch, 'agent-desk/arreglar-nandu-abc12345');
    assert.equal(wt.base, 'main');
    assert.equal(wt.root, repo);
    assert.equal(wt.cwd, wt.path);
    assert.ok(wt.path.startsWith(path.join(data, 'worktrees')), 'fuera del proyecto');
    assert.equal(await git(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD'), wt.branch);
    assert.equal(await git(wt.path, 'rev-parse', 'HEAD'), await git(repo, 'rev-parse', 'HEAD'));
    assert.ok(lstatSync(path.join(wt.path, 'node_modules')).isSymbolicLink());
    assert.equal(await git(wt.path, 'status', '--porcelain'), '', 'el enlace queda excluido');
    assert.equal(await git(repo, 'status', '--porcelain'), '');
    const status = await worktreeStatus(wt);
    assert.deepEqual(
      { exists: status.exists, ahead: status.ahead, behind: status.behind, dirty: status.dirty },
      { exists: true, ahead: 0, behind: 0, dirty: 0 },
    );
    assert.equal(status.mainBranch, 'main');
    // A second chat with the same title gets its own branch.
    const other = await createWorktree({
      project: repo,
      dataDir: data,
      title: 'Arreglar ñandú',
      id: 'abc12345-y',
    });
    assert.notEqual(other.branch, wt.branch);
    await removeWorktree(other);
    await removeWorktree(wt);
  }));

test('una subcarpeta del repositorio trabaja en la misma subcarpeta del worktree', async () =>
  fixture(async (_root, repo, data) => {
    const sub = path.join(repo, 'packages', 'web');
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(sub, 'index.ts'), 'export {};\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'web');
    const wt = await createWorktree({ project: sub, dataDir: data, title: 'web', id: '1' });
    assert.equal(wt.cwd, path.join(wt.path, 'packages', 'web'));
    assert.ok(existsSync(path.join(wt.cwd, 'index.ts')));
    await removeWorktree(wt);
  }));

test('fusiona los cambios del agente en la rama base con commit automático', async () =>
  fixture(async (_root, repo, data) => {
    const wt = await createWorktree({ project: repo, dataDir: data, title: 'nuevo', id: '2' });
    await fs.writeFile(path.join(wt.path, 'b.txt'), 'nuevo\n');
    await fs.writeFile(path.join(wt.path, 'a.txt'), 'uno\ndos\n');
    assert.equal((await worktreeStatus(wt)).dirty, 2);
    const result = await mergeWorktree(wt, 'Añade b');
    assert.equal(result.merged, true);
    assert.equal(await fs.readFile(path.join(repo, 'b.txt'), 'utf8'), 'nuevo\n');
    assert.equal(await git(repo, 'status', '--porcelain'), '');
    assert.equal((await worktreeStatus(wt)).dirty, 0);
    const again = await mergeWorktree(wt, 'Añade b');
    assert.equal(again.upToDate, true);
    await removeWorktree(wt);
    assert.equal(existsSync(wt.path), false);
    assert.equal(await git(repo, 'branch', '--list', wt.branch), '');
  }));

test('detecta conflictos sin tocar la copia principal y los lleva al worktree al actualizar', async () =>
  fixture(async (_root, repo, data) => {
    const wt = await createWorktree({ project: repo, dataDir: data, title: 'conflicto', id: '3' });
    await fs.writeFile(path.join(repo, 'a.txt'), 'principal\n');
    await git(repo, 'commit', '-am', 'cambio principal');
    await fs.writeFile(path.join(wt.path, 'a.txt'), 'agente\n');
    const head = await git(repo, 'rev-parse', 'HEAD');
    const result = await mergeWorktree(wt, 'Cambia a');
    assert.equal(result.merged, false);
    assert.deepEqual(result.conflicts, ['a.txt']);
    assert.equal(await git(repo, 'rev-parse', 'HEAD'), head);
    assert.equal(await git(repo, 'status', '--porcelain'), '');
    assert.equal(await fs.readFile(path.join(repo, 'a.txt'), 'utf8'), 'principal\n');
    const status = await worktreeStatus(wt);
    assert.equal(status.ahead, 1);
    assert.equal(status.behind, 1);
    const update = await updateWorktree(wt, 'Cambia a');
    assert.deepEqual(update.conflicts, ['a.txt']);
    assert.equal((await worktreeStatus(wt)).conflicts, 1);
    await assert.rejects(mergeWorktree(wt, 'x'), /conflictos del worktree/);
    await fs.writeFile(path.join(wt.path, 'a.txt'), 'resuelto\n');
    await git(wt.path, 'commit', '-am', 'resuelve');
    const merged = await mergeWorktree(wt, 'Cambia a');
    assert.equal(merged.merged, true);
    assert.equal(await fs.readFile(path.join(repo, 'a.txt'), 'utf8'), 'resuelto\n');
    await removeWorktree(wt);
  }));

test('no fusiona si la copia principal cambió de rama o tiene cambios sin commit', async () =>
  fixture(async (_root, repo, data) => {
    const wt = await createWorktree({ project: repo, dataDir: data, title: 'x', id: '4' });
    await fs.writeFile(path.join(wt.path, 'c.txt'), 'c\n');
    await fs.writeFile(path.join(repo, 'a.txt'), 'sin commit\n');
    await assert.rejects(mergeWorktree(wt, 'x'), /cambios sin commit/);
    await git(repo, 'checkout', '--', 'a.txt');
    await git(repo, 'switch', '-c', 'otra');
    await assert.rejects(mergeWorktree(wt, 'x'), /Cambia a main/);
    await git(repo, 'switch', 'main');
    assert.equal((await mergeWorktree(wt, 'x')).merged, true);
    await removeWorktree(wt);
  }));

test('una copia duplicada parte del estado del worktree de origen y fusiona en la misma base', async () =>
  fixture(async (_root, repo, data) => {
    const source = await createWorktree({ project: repo, dataDir: data, title: 'origen', id: '5' });
    await fs.writeFile(path.join(source.path, 'idea.txt'), 'enfoque\n');
    await git(source.path, 'add', '.');
    await git(source.path, 'commit', '-m', 'idea');
    const copy = await createWorktree({
      project: repo,
      dataDir: data,
      title: 'copia',
      id: '6',
      from: source,
    });
    assert.equal(copy.base, 'main');
    assert.equal(await fs.readFile(path.join(copy.path, 'idea.txt'), 'utf8'), 'enfoque\n');
    assert.equal((await worktreeStatus(copy)).ahead, 1);
    await removeWorktree(copy);
    await removeWorktree(source);
  }));

test('rechaza carpetas sin Git, repositorios sin commits y HEAD separado', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desk-worktree-')));
  try {
    await assert.rejects(
      createWorktree({ project: root, dataDir: path.join(root, 'd'), title: 'x', id: '1' }),
      /no es un repositorio/,
    );
    await git(root, 'init', '-b', 'main');
    await assert.rejects(
      createWorktree({ project: root, dataDir: path.join(root, 'd'), title: 'x', id: '1' }),
      /no tiene commits/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  await fixture(async (_r, repo, data) => {
    await git(repo, 'checkout', '--detach');
    await assert.rejects(
      createWorktree({ project: repo, dataDir: data, title: 'x', id: '1' }),
      /HEAD separado/,
    );
  });
});

test('lee symlinkDirectories de los ajustes oficiales del proyecto', async () =>
  fixture(async (_root, repo) => {
    assert.deepEqual(worktreeSettings(repo).symlinkDirectories, ['node_modules']);
    await fs.mkdir(path.join(repo, '.claude'));
    await fs.writeFile(
      path.join(repo, '.claude', 'settings.json'),
      JSON.stringify({ worktree: { symlinkDirectories: ['.cache'] } }),
    );
    assert.deepEqual(worktreeSettings(repo).symlinkDirectories, ['.cache']);
    assert.equal(worktreeSlug('¡¡!!', 'ABCDEF12-3'), 'abcdef12');
  }));

const chat = (patch: Partial<Session>): Session => ({
  id: 's1',
  projectId: 'p',
  profile: 'claude-1',
  title: 'Sesión 1',
  status: 'stopped',
  messages: [],
  approvals: [],
  ...patch,
});
test('aísla por defecto un chat nuevo cuando ya hay otro agente vivo en el proyecto', () => {
  const s = chat({});
  const other = chat({ id: 's2', status: 'ready' });
  const elsewhere = chat({ id: 's3', projectId: 'q', status: 'working' });
  assert.equal(wantsWorktree(s, [s]), false);
  assert.equal(wantsWorktree(s, [s, elsewhere]), false);
  assert.equal(wantsWorktree(s, [s, other]), true);
  assert.equal(wantsWorktree({ ...s, isolation: 'shared' }, [s, other]), false);
  assert.equal(wantsWorktree({ ...s, isolation: 'worktree' }, [s]), true);
  // A chat that already worked in the shared folder keeps it unless duplicated.
  assert.equal(wantsWorktree({ ...s, attempted: true }, [s, other]), false);
  assert.equal(isolationLocked({ ...s, attempted: true }), true);
  assert.equal(isolationLocked({ ...s, attempted: true, forkFrom: 'x' }), false);
  assert.equal(canIsolate(chat({ profile: 'codex' })), false);
  assert.equal(wantsWorktree(chat({ profile: 'codex' }), [other]), false);
});

test('duplicar usa resume + forkSession con un id nuevo, también en la terminal oficial', () => {
  const options = claudeOptions(
    { reference: 'nuevo', attempted: false, forkFrom: 'origen' },
    { cwd: '/tmp', binary: '/bin/claude', profileDir: '/tmp/p' },
  );
  assert.equal(options.resume, 'origen');
  assert.equal(options.forkSession, true);
  assert.equal(options.sessionId, 'nuevo');
  assert.equal(options.enableFileCheckpointing, true);
  const resumed = claudeOptions(
    { reference: 'nuevo', attempted: true },
    { cwd: '/tmp', binary: '/bin/claude', profileDir: '/tmp/p' },
  );
  assert.equal(resumed.resume, 'nuevo');
  assert.equal(resumed.forkSession, undefined);
  assert.deepEqual(claudeArgs({ reference: 'nuevo', forkFrom: 'origen' }).slice(0, 5), [
    '--resume',
    'origen',
    '--fork-session',
    '--session-id',
    'nuevo',
  ]);
  for (const action of [
    { type: 'setIsolation', sessionId: 's', isolation: 'worktree' },
    { type: 'worktree', sessionId: 's', operation: 'merge' },
    { type: 'forkSession', sessionId: 's', isolate: true },
    { type: 'rewindFiles', sessionId: 's', messageId: 'u-1', dryRun: true },
    { type: 'diff', projectId: 'p', sessionId: 's' },
  ])
    assert.equal(actionSchema.safeParse(action).success, true, action.type);
  assert.equal(
    actionSchema.safeParse({ type: 'worktree', sessionId: 's', operation: 'reset' }).success,
    false,
  );
});

test('el gestor duplica un chat en otro worktree, fusiona, descarta y persiste el aislamiento', async () =>
  fixture(async (root, repo) => {
    const manager = new Manager(path.join(root, 'state'), () => {});
    try {
      const account = manager.addAccount('claude');
      const project = await manager.addProject(repo);
      const source = manager.state.sessions[0];
      await assert.rejects(manager.fork(source.id, true), /al menos un mensaje/);
      source.attempted = true;
      source.messages.push({ id: 'u-1', role: 'user', text: 'hola', checkpoint: 'c1' });
      const fork = await manager.fork(source.id, true);
      assert.equal(fork.forkFrom, source.reference);
      assert.equal(fork.forkOf, source.id);
      assert.equal(fork.profile, account.id);
      assert.notEqual(fork.reference, source.reference);
      assert.equal(
        fork.messages[0].checkpoint,
        undefined,
        'el fork no hereda puntos de restauración',
      );
      assert.ok(fork.worktree?.branch.startsWith('agent-desk/'));
      assert.equal(manager.state.selectedSession, fork.id);
      // Git operations on the main checkout are not blocked by an isolated chat.
      manager.runtimes.set(fork.id, { buffer: '', sequence: 0 });
      await manager.gitOperation(project.id, 'stage');
      manager.runtimes.set(source.id, { buffer: '', sequence: 0 });
      await assert.rejects(manager.gitOperation(project.id, 'stage'), /Detén los agentes/);
      manager.runtimes.clear();
      const snapshot = await manager.diff(project.id, fork.id);
      assert.equal(snapshot.worktree?.branch, fork.worktree!.branch);
      await fs.writeFile(path.join(fork.worktree!.path, 'fork.txt'), 'f\n');
      // A shared agent in the main checkout blocks merging into it.
      manager.runtimes.set(source.id, { buffer: '', sequence: 0 });
      await assert.rejects(manager.worktree(fork.id, 'merge'), /copia principal/);
      manager.runtimes.clear();
      const merged = await manager.worktree(fork.id, 'merge');
      assert.equal(merged.merged, true);
      assert.ok(existsSync(path.join(repo, 'fork.txt')));
      assert.throws(() => manager.setIsolation(fork.id, 'shared'), /ya tiene un worktree/);
      manager.store.flush();
      const restored = new Manager(path.join(root, 'state'), () => {});
      const saved = restored.session(fork.id);
      assert.equal(saved.worktree?.branch, fork.worktree!.branch);
      assert.equal(saved.forkFrom, source.reference);
      assert.equal(restored.session(source.id).messages[0].checkpoint, 'c1');
      const branch = fork.worktree!.branch;
      const checkout = fork.worktree!.path;
      await manager.worktree(fork.id, 'discard');
      assert.equal(fork.worktree, undefined);
      assert.equal(existsSync(checkout), false);
      assert.equal(await git(repo, 'branch', '--list', branch), '');
      const fresh = manager.newSession(project.id, account.id);
      manager.setIsolation(fresh.id, 'worktree');
      assert.equal(fresh.isolation, 'worktree');
      await assert.rejects(manager.rewind(source.id, 'u-404'), /punto de restauración/);
    } finally {
      manager.runtimes.clear();
      await manager.shutdown();
    }
  }));
