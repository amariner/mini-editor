import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cleanEnv } from './core';
import type { GitSnapshot, GitOperation } from '../src/git-types';
const exec = promisify(execFile);
const empty = (): GitSnapshot => ({
  repository: false,
  branch: '',
  branches: [],
  files: [],
  counts: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
  status: '',
  staged: '',
  unstaged: '',
  commits: [],
});
async function git(cwd: string, args: string[], network = false) {
  try {
    return (
      await exec('git', ['--no-pager', ...args], {
        cwd,
        env: { ...cleanEnv(), LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
        timeout: network ? 60000 : 15000,
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout;
  } catch (error) {
    const e = error as Error & { stderr?: string };
    throw new Error((e.stderr?.trim() || e.message).slice(0, 1200));
  }
}
export async function repositoryRoot(cwd: string) {
  try {
    return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  } catch (error) {
    if (/not a git repository/i.test((error as Error).message)) return undefined;
    throw error;
  }
}
export function parseGitFiles(raw: string): GitSnapshot['files'] {
  const records = raw.split('\0');
  const files: GitSnapshot['files'] = [];
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (!row) continue;
    const status = row.slice(0, 2);
    files.push({
      path: row.slice(3),
      index: status[0],
      worktree: status[1],
      conflict: ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(status),
    });
    if (/[RC]/.test(status)) i++; // -z includes the original path as a second record.
  }
  return files;
}
export async function readGit(cwd: string): Promise<GitSnapshot> {
  const root = await repositoryRoot(cwd);
  if (!root) return empty();
  const [raw, status, symbolic, head, refs, upstream, remotes] = await Promise.all([
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    git(root, ['status', '--short']),
    git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
    git(root, ['rev-parse', '--verify', '--short', 'HEAD']).catch(() => ''),
    git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => ''),
    git(root, ['remote']),
  ]);
  const files = parseGitFiles(raw);
  const result: GitSnapshot = {
    ...empty(),
    repository: true,
    branch: symbolic.trim() || `HEAD · ${head.trim()}`,
    detached: !symbolic.trim(),
    unborn: !head.trim(),
    branches: refs.trim().split('\n').filter(Boolean),
    upstream: upstream.trim() || undefined,
    remote: remotes.trim().split('\n').filter(Boolean).includes('origin')
      ? 'origin'
      : remotes.trim().split('\n').filter(Boolean)[0],
    files,
    status,
    counts: {
      staged: files.filter((f) => !f.conflict && ![' ', '?'].includes(f.index)).length,
      unstaged: files.filter((f) => !f.conflict && ![' ', '?'].includes(f.worktree)).length,
      untracked: files.filter((f) => f.index === '?').length,
      conflicts: files.filter((f) => f.conflict).length,
    },
  };
  if (symbolic.trim() && !result.branches.includes(symbolic.trim()))
    result.branches.unshift(symbolic.trim());
  if (result.upstream && head.trim()) {
    const counts = (await git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']))
      .trim()
      .split(/\s+/);
    result.ahead = Number(counts[0]);
    result.behind = Number(counts[1]);
  }
  if (head.trim())
    result.commits = (await git(root, ['log', '-5', '--format=%h%x00%s']))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, subject] = line.split('\0');
        return { hash, subject };
      });
  try {
    const [unstaged, staged, a, b] = await Promise.all([
      git(root, ['diff', '--no-ext-diff', '--no-textconv', '--']),
      git(root, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--']),
      git(root, ['diff', '--numstat', '--no-ext-diff', '--no-textconv', '--']),
      git(root, ['diff', '--cached', '--numstat', '--no-ext-diff', '--no-textconv', '--']),
    ]);
    result.unstaged = unstaged;
    result.staged = staged;
    result.lines = (a + '\n' + b).split('\n').reduce(
      (sum, row) => {
        const [added, removed] = row.split('\t');
        if (/^\d+$/.test(added) && /^\d+$/.test(removed)) {
          sum.added += Number(added);
          sum.removed += Number(removed);
        }
        return sum;
      },
      { added: 0, removed: 0 },
    );
  } catch {
    result.diffError =
      'El diff no está disponible o supera el tamaño admitido. Puedes seguir consultando el estado de Git.';
  }
  return result;
}
export async function changeGit(cwd: string, operation: GitOperation, value?: string) {
  const root = await repositoryRoot(cwd);
  if (!root) throw new Error('Esta carpeta no es un repositorio Git.');
  const state = await readGit(root);
  if (['switch', 'create', 'pull'].includes(operation) && state.files.length)
    throw new Error('Guarda tus cambios en un commit antes de cambiar de rama o bajar cambios.');
  if (['commit', 'push'].includes(operation) && state.counts.conflicts)
    throw new Error('Resuelve los conflictos antes de continuar.');
  let output = '';
  switch (operation) {
    case 'stage':
      output = await git(root, ['add', '--all', '--', '.']);
      break;
    case 'unstage':
      output = await git(
        root,
        state.unborn
          ? ['rm', '--cached', '-r', '--ignore-unmatch', '--', '.']
          : ['restore', '--staged', '--', '.'],
      );
      break;
    case 'commit':
      if (!value?.trim()) throw new Error('Escribe un mensaje para el commit.');
      if (!state.counts.staged) throw new Error('Prepara los cambios antes de crear el commit.');
      output = await git(root, ['commit', '-m', value.trim()]);
      break;
    case 'create':
    case 'switch':
      if (!value || value.startsWith('-')) throw new Error('Nombre de rama no válido.');
      await git(root, ['check-ref-format', `refs/heads/${value}`]);
      if (operation === 'switch' && !state.branches.includes(value))
        throw new Error('La rama local ya no existe. Actualiza la lista.');
      output = await git(
        root,
        operation === 'create' ? ['switch', '-c', value] : ['switch', '--no-guess', value],
      );
      break;
    case 'fetch':
      if (!state.remote) throw new Error('Configura un remoto para consultar sus cambios.');
      output = await git(root, ['fetch', '--all'], true);
      break;
    case 'pull':
      if (!state.upstream) throw new Error('Esta rama no tiene una rama remota de seguimiento.');
      output = await git(root, ['pull', '--ff-only'], true);
      break;
    case 'push':
      if (state.detached || state.unborn)
        throw new Error('Selecciona una rama con al menos un commit antes de subirla.');
      if (!state.remote) throw new Error('Configura un remoto antes de subir cambios.');
      if (state.upstream) {
        const remote = (
          await git(root, ['config', '--get', `branch.${state.branch}.remote`])
        ).trim();
        const target = (
          await git(root, ['config', '--get', `branch.${state.branch}.merge`])
        ).trim();
        if (!remote || !target.startsWith('refs/heads/'))
          throw new Error('La rama remota de seguimiento no es válida.');
        output = await git(root, ['push', '--', remote, `HEAD:${target}`], true);
      } else
        output = await git(
          root,
          ['push', '--set-upstream', '--', state.remote, `HEAD:refs/heads/${state.branch}`],
          true,
        );
      break;
  }
  return { output: output.trim(), state: await readGit(root) };
}
