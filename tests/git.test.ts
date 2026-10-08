import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readGit, changeGit, parseGitFiles } from '../electron/git';
import { actionSchema } from '../electron/core';
import { Manager } from '../electron/manager';
const exec = promisify(execFile);
const command = async (cwd: string, ...args: string[]) =>
  (await exec('git', args, { cwd })).stdout.trim();
async function fixture(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-git-'));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
async function init(root: string) {
  await command(root, 'init', '-b', 'main');
  await command(root, 'config', 'user.name', 'Agent Desk Test');
  await command(root, 'config', 'user.email', 'test@example.invalid');
  await command(root, 'config', 'commit.gpgsign', 'false');
  await command(root, 'config', 'core.hooksPath', '/dev/null');
}
test('Git diferencia una carpeta normal, rama sin commits, preparación, commit y cambios de rama', async () =>
  fixture(async (root) => {
    assert.equal((await readGit(root)).repository, false);
    await init(root);
    assert.equal((await readGit(root)).unborn, true);
    const name = 'archivo con espacios\ny salto.txt';
    await fs.writeFile(path.join(root, name), 'uno\n');
    assert.equal((await readGit(root)).counts.untracked, 1);
    await assert.rejects(changeGit(root, 'create', 'feature/prueba'), /Guarda tus cambios/);
    await changeGit(root, 'stage');
    assert.equal((await readGit(root)).counts.staged, 1);
    await changeGit(root, 'unstage');
    assert.equal(await fs.readFile(path.join(root, name), 'utf8'), 'uno\n');
    await changeGit(root, 'stage');
    await changeGit(root, 'commit', 'Primer commit');
    let state = await readGit(root);
    assert.equal(state.counts.untracked, 0);
    assert.equal(state.commits[0].subject, 'Primer commit');
    await changeGit(root, 'create', 'feature/prueba');
    assert.equal((await readGit(root)).branch, 'feature/prueba');
    await assert.rejects(changeGit(root, 'create', '-b'), /Nombre de rama/);
    await assert.rejects(changeGit(root, 'switch', 'no-existe'), /ya no existe/);
    await changeGit(root, 'switch', 'main');
    await fs.writeFile(path.join(root, name), 'uno\ndos\n');
    await changeGit(root, 'stage');
    await fs.appendFile(path.join(root, name), 'tres\n');
    state = await readGit(root);
    assert.equal(state.counts.staged, 1);
    assert.equal(state.counts.unstaged, 1);
    assert.equal(state.files[0].path, name);
    assert.deepEqual(state.lines, { added: 2, removed: 0 });
    await changeGit(root, 'unstage');
    assert.equal((await readGit(root)).counts.staged, 0);
  }));
test('Git publica, consulta y baja con avance rápido; no fuerza una rama divergente', async () =>
  fixture(async (root) => {
    const local = path.join(root, 'local'),
      remote = path.join(root, 'remote.git'),
      other = path.join(root, 'other');
    await fs.mkdir(local);
    await init(local);
    await command(root, 'init', '--bare', '-b', 'main', remote);
    await command(local, 'remote', 'add', 'origin', remote);
    await fs.writeFile(path.join(local, 'file.txt'), 'base\n');
    await changeGit(local, 'stage');
    await changeGit(local, 'commit', 'Base');
    await changeGit(local, 'push');
    assert.equal((await readGit(local)).upstream, 'origin/main');
    await command(root, 'clone', remote, other);
    await command(other, 'config', 'user.name', 'Test');
    await command(other, 'config', 'user.email', 'test@example.invalid');
    await command(other, 'config', 'commit.gpgsign', 'false');
    await command(other, 'config', 'core.hooksPath', '/dev/null');
    await fs.writeFile(path.join(other, 'remote.txt'), 'remote');
    await changeGit(other, 'stage');
    await changeGit(other, 'commit', 'Remoto');
    await changeGit(other, 'push');
    await changeGit(local, 'fetch');
    assert.equal((await readGit(local)).behind, 1);
    await changeGit(local, 'pull');
    assert.equal(await fs.readFile(path.join(local, 'remote.txt'), 'utf8'), 'remote');
    await fs.writeFile(path.join(other, 'remote.txt'), 'otra');
    await changeGit(other, 'stage');
    await changeGit(other, 'commit', 'Remoto 2');
    await changeGit(other, 'push');
    await fs.writeFile(path.join(local, 'local.txt'), 'local');
    await changeGit(local, 'stage');
    await changeGit(local, 'commit', 'Local');
    await changeGit(local, 'fetch');
    const before = await command(local, 'rev-parse', 'HEAD');
    assert.equal((await readGit(local)).ahead, 1);
    assert.equal((await readGit(local)).behind, 1);
    await assert.rejects(changeGit(local, 'pull'));
    await assert.rejects(changeGit(local, 'push'));
    assert.equal(await command(local, 'rev-parse', 'HEAD'), before);
  }));
test('Git interpreta renombres y conflictos y valida operaciones IPC', () => {
  const files = parseGitFiles('R  nuevo nombre\0viejo nombre\0UU conflicto.txt\0?? nuevo.txt\0');
  assert.equal(files.length, 3);
  assert.equal(files[0].path, 'nuevo nombre');
  assert.equal(files[1].conflict, true);
  assert.equal(
    actionSchema.safeParse({ type: 'gitOperation', projectId: 'p', operation: 'reset-hard' })
      .success,
    false,
  );
});
test('Git detecta conflictos reales y HEAD separado sin perder archivos', async () =>
  fixture(async (root) => {
    await init(root);
    await fs.writeFile(path.join(root, 'a.txt'), 'base\n');
    await changeGit(root, 'stage');
    await changeGit(root, 'commit', 'Base');
    await changeGit(root, 'create', 'other');
    await fs.writeFile(path.join(root, 'a.txt'), 'other\n');
    await changeGit(root, 'stage');
    await changeGit(root, 'commit', 'Other');
    await changeGit(root, 'switch', 'main');
    await fs.writeFile(path.join(root, 'a.txt'), 'main\n');
    await changeGit(root, 'stage');
    await changeGit(root, 'commit', 'Main');
    await assert.rejects(command(root, 'merge', 'other'));
    assert.equal((await readGit(root)).counts.conflicts, 1);
    await assert.rejects(changeGit(root, 'commit', 'No'), /conflictos/);
    await assert.rejects(changeGit(root, 'switch', 'other'), /Guarda/);
    await command(root, 'merge', '--abort');
    await command(root, 'checkout', '--detach');
    assert.equal((await readGit(root)).detached, true);
    await assert.rejects(changeGit(root, 'push'), /Selecciona una rama/);
  }));

test('las operaciones Git se serializan y bloquean arranques y reinicios; respetan agentes abiertos', async () =>
  fixture(async (root) => {
    const project = path.join(root, 'project');
    await fs.mkdir(project);
    await init(project);
    const manager = new Manager(path.join(root, 'data'), () => {});
    try {
      const account = manager.addAccount('claude');
      const p = await manager.addProject(project);
      const session = manager.state.sessions[0];
      await fs.writeFile(path.join(project, 'a.txt'), 'test\n');
      manager.runtimes.set(session.id, { buffer: '', sequence: 0 });
      await assert.rejects(manager.gitOperation(p.id, 'stage'), /Detén los agentes/);
      assert.equal((await readGit(project)).counts.staged, 0);
      manager.runtimes.clear();
      await manager.gitOperation(p.id, 'stage');
      const hooks = path.join(root, 'hooks');
      await fs.mkdir(hooks);
      await fs.writeFile(path.join(hooks, 'pre-commit'), '#!/bin/sh\nsleep 0.3\n', { mode: 0o700 });
      await command(project, 'config', 'core.hooksPath', hooks);
      const commit = manager.gitOperation(p.id, 'commit', 'Lock test');
      for (let i = 0; i < 100 && manager.canRestart; i++)
        await new Promise((r) => setTimeout(r, 5));
      assert.equal(manager.canRestart, false);
      const other = manager.newSession(p.id, account.id);
      await assert.rejects(manager.start(other.id), /operación de Git/);
      await assert.rejects(manager.gitOperation(p.id, 'stage'), /operación de Git en curso/);
      await commit;
      assert.equal(manager.canRestart, true);
    } finally {
      manager.runtimes.clear();
      await manager.shutdown();
    }
  }));
