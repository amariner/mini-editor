import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  readWorkspaceDiff,
  stageWorkspaceFile,
} from '../electron/workspace-files';
import { readGit } from '../electron/git';
import { actionSchema } from '../electron/core';
import { Manager } from '../electron/manager';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await exec('git', args, { cwd })).stdout.trim();
async function fixture(run: (root: string, repo: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desk-workspace-')));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  try {
    await run(root, repo);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
async function init(repo: string) {
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Workspace Test');
  await git(repo, 'config', 'user.email', 'test@example.invalid');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  await git(repo, 'config', 'core.hooksPath', '/dev/null');
}

test('workspace browser lists one directory and searches nested files without following symlinks', async () =>
  fixture(async (root, repo) => {
    await fs.mkdir(path.join(repo, 'src'));
    await fs.mkdir(path.join(repo, '.git'));
    await fs.mkdir(path.join(repo, 'node_modules'));
    await fs.writeFile(path.join(repo, 'README.md'), 'readme');
    await fs.writeFile(path.join(repo, 'src/main.ts'), 'main');
    await fs.writeFile(path.join(repo, 'node_modules/main.ts'), 'dependency');
    await fs.writeFile(path.join(root, 'outside.txt'), 'outside');
    await fs.symlink(path.join(root, 'outside.txt'), path.join(repo, 'linked.txt'));
    const listing = await listWorkspaceFiles(repo);
    assert.deepEqual(
      listing.entries.map((entry) => entry.path),
      ['node_modules', 'src', 'README.md'],
    );
    assert.equal(listing.root, repo);
    assert.deepEqual(
      (await listWorkspaceFiles(repo, 'src')).entries.map((entry) => entry.path),
      ['src/main.ts'],
    );
    assert.deepEqual(
      (await listWorkspaceFiles(repo, '', 'main')).entries.map((entry) => entry.path),
      ['src/main.ts'],
    );
    await assert.rejects(listWorkspaceFiles(repo, '..'), /fuera del proyecto/);
    await assert.rejects(readWorkspaceFile(repo, 'linked.txt'), /enlaces simbólicos/);
    await assert.rejects(
      readWorkspaceFile(repo, path.join(root, 'outside.txt')),
      /fuera del proyecto/,
    );
    await assert.rejects(listWorkspaceFiles(repo, '.git'), /internos de Git/);
  }));

test('file previews are bounded, detect binary data, and accept absolute paths inside the checkout', async () =>
  fixture(async (_root, repo) => {
    await fs.writeFile(path.join(repo, 'large.ts'), 'x'.repeat(300 * 1024));
    await fs.writeFile(path.join(repo, 'image.bin'), Buffer.from([0, 1, 2, 3]));
    const large = await readWorkspaceFile(repo, path.join(repo, 'large.ts'));
    assert.equal(large.path, 'large.ts');
    assert.equal(large.content.length, 256 * 1024);
    assert.equal(large.size, 300 * 1024);
    assert.equal(large.truncated, true);
    assert.equal(large.binary, false);
    const binary = await readWorkspaceFile(repo, 'image.bin');
    assert.equal(binary.binary, true);
    assert.equal(binary.content, '');
    await assert.rejects(readWorkspaceFile(repo, '.'), /Selecciona un archivo/);
  }));

test('chat file references normalize URLs and line anchors inside the checkout only', async () =>
  fixture(async (root, repo) => {
    const file = path.join(repo, 'with spaces.ts');
    await fs.writeFile(file, 'export const value = 1;\n');
    for (const reference of [
      `${file}:12:2`,
      `${file}#L12-L20`,
      `${pathToFileURL(file).href}#L12`,
      'with spaces.ts:12',
    ]) {
      assert.equal((await readWorkspaceFile(repo, reference)).path, 'with spaces.ts');
    }
    await fs.writeFile(path.join(repo, 'literal:12'), 'exact');
    assert.equal((await readWorkspaceFile(repo, 'literal:12')).content, 'exact');
    await fs.writeFile(path.join(root, 'outside.ts'), 'outside');
    await assert.rejects(
      readWorkspaceFile(repo, pathToFileURL(path.join(root, 'outside.ts')).href),
      /fuera del proyecto/,
    );
    await assert.rejects(readWorkspaceFile(repo, '~/outside.ts'), /fuera del proyecto/);
    await fs.symlink(file, path.join(repo, 'link.ts'));
    await assert.rejects(
      readWorkspaceFile(repo, `${pathToFileURL(path.join(repo, 'link.ts')).href}#L1`),
      /enlaces simbólicos/,
    );
  }));

test('individual staging treats pathspec metacharacters literally and unstaging preserves edited new files', async () =>
  fixture(async (_root, repo) => {
    await init(repo);
    await fs.writeFile(path.join(repo, '*'), 'first\n');
    await fs.writeFile(path.join(repo, 'ordinary.txt'), 'untouched\n');
    await stageWorkspaceFile(repo, '*', true);
    let status = await readGit(repo, true);
    assert.equal(status.counts.staged, 1);
    assert.equal(status.files.find((file) => file.path === 'ordinary.txt')?.index, '?');
    await fs.writeFile(path.join(repo, '*'), 'edited after staging\n');
    await stageWorkspaceFile(repo, '*', false);
    status = await readGit(repo, true);
    assert.equal(status.counts.staged, 0);
    assert.equal(await fs.readFile(path.join(repo, '*'), 'utf8'), 'edited after staging\n');
    await assert.rejects(stageWorkspaceFile(repo, '../ordinary.txt', true), /fuera del proyecto/);
    await assert.rejects(stageWorkspaceFile(repo, '.', true), /Selecciona un archivo/);
  }));

test('diffs cover new, deleted, binary and renamed files and unstage the whole selected rename', async () =>
  fixture(async (_root, repo) => {
    await init(repo);
    await fs.writeFile(path.join(repo, 'old name.txt'), 'before\n');
    assert.match((await readWorkspaceDiff(repo, 'old name.txt', false)).patch, /\+before/);
    await stageWorkspaceFile(repo, 'old name.txt', true);
    assert.match((await readWorkspaceDiff(repo, 'old name.txt', true)).patch, /\+before/);
    await git(repo, 'commit', '-m', 'base');
    await git(repo, 'mv', 'old name.txt', 'new name.txt');
    const rename = await readWorkspaceDiff(repo, 'new name.txt', true);
    assert.match(rename.patch, /rename from old name.txt/);
    assert.match(rename.patch, /rename to new name.txt/);
    await stageWorkspaceFile(repo, 'new name.txt', false);
    assert.equal((await readGit(repo, true)).counts.staged, 0);
    assert.equal(await fs.readFile(path.join(repo, 'new name.txt'), 'utf8'), 'before\n');
    assert.match((await readWorkspaceDiff(repo, 'old name.txt', false)).patch, /-before/);
    await fs.writeFile(path.join(repo, 'binary.bin'), Buffer.from([0, 1, 2]));
    assert.equal((await readWorkspaceDiff(repo, 'binary.bin', false)).binary, true);
    await fs.mkdir(path.join(repo, 'folder'));
    await assert.rejects(readWorkspaceDiff(repo, 'folder', false), /Selecciona un archivo/);
  }));

test('large diffs return an explicit truncated preview instead of failing or reading unbounded output', async () =>
  fixture(async (_root, repo) => {
    await init(repo);
    await fs.writeFile(path.join(repo, 'large.txt'), 'a line of generated content\n'.repeat(80000));
    const diff = await readWorkspaceDiff(repo, 'large.txt', false);
    assert.equal(diff.truncated, true);
    assert.ok(diff.patch.length <= 1024 * 1024);
    assert.match(diff.patch, /@@/);
  }));

test('manager resolves subprojects and isolated worktrees, rejects foreign sessions and blocks active checkout staging', async () =>
  fixture(async (root, repo) => {
    await init(repo);
    await fs.mkdir(path.join(repo, 'src'));
    await fs.writeFile(path.join(repo, 'src/main.ts'), 'base\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'base');
    const worktree = path.join(root, 'isolated');
    await git(repo, 'worktree', 'add', '-b', 'isolated', worktree);
    const manager = new Manager(path.join(root, 'data'), () => {});
    try {
      const account = manager.addAccount('claude');
      const project = await manager.addProject(path.join(repo, 'src'));
      const session = manager.state.sessions[0];
      assert.equal(await manager.workspaceRoot(project.id, session.id), repo);
      const foreign = manager.newSession(project.id, account.id);
      foreign.projectId = 'foreign';
      await assert.rejects(manager.workspaceRoot(project.id, foreign.id), /otro proyecto/);
      foreign.projectId = project.id;
      session.worktree = {
        path: worktree,
        cwd: path.join(worktree, 'src'),
        root: repo,
        branch: 'isolated',
        base: 'main',
        baseCommit: await git(repo, 'rev-parse', 'HEAD'),
        createdAt: Date.now(),
      };
      assert.equal(await manager.workspaceRoot(project.id, session.id), worktree);
      await fs.writeFile(path.join(worktree, 'src/main.ts'), 'isolated\n');
      await manager.workspaceStage(project.id, session.id, 'src/main.ts', true);
      assert.equal((await readGit(worktree, true)).counts.staged, 1);
      assert.equal((await readGit(repo, true)).counts.staged, 0);
      manager.runtimes.set(session.id, { buffer: '', sequence: 0 });
      await assert.rejects(
        manager.workspaceStage(project.id, session.id, 'src/main.ts', false),
        /Detén los agentes/,
      );
      manager.runtimes.clear();
      await manager.workspaceStage(project.id, session.id, 'src/main.ts', false);
      (manager as any).gitJobs.add(repo);
      await assert.rejects(
        manager.workspaceStage(project.id, session.id, 'src/main.ts', true),
        /operación de Git/,
      );
      (manager as any).gitJobs.clear();
      await fs.rm(path.join(worktree, 'src'), { recursive: true });
      await assert.rejects(manager.workspaceRoot(project.id, session.id));
    } finally {
      manager.runtimes.clear();
      (manager as any).gitJobs.clear();
      await manager.shutdown();
    }
  }));

test('workspace IPC validates scope, lengths and staged mode', () => {
  for (const type of ['workspaceFiles', 'workspaceFile', 'workspaceDiff', 'workspaceStage']) {
    const action = {
      type,
      projectId: 'p',
      sessionId: 's',
      ...(type === 'workspaceFiles' ? {} : { path: 'src/file.ts' }),
      ...(['workspaceDiff', 'workspaceStage'].includes(type) ? { staged: true } : {}),
    };
    assert.equal(actionSchema.safeParse(action).success, true);
    assert.equal(actionSchema.safeParse({ ...action, extra: true }).success, false);
  }
  assert.equal(
    actionSchema.safeParse({ type: 'workspaceStage', projectId: 'p', path: 'x', staged: 'true' })
      .success,
    false,
  );
  assert.equal(
    actionSchema.safeParse({ type: 'workspaceFile', projectId: 'p', path: '' }).success,
    false,
  );
});
