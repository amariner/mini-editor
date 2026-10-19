import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cleanEnv } from './core';
import type { SessionWorktree, WorktreeMergeResult, WorktreeStatus } from '../src/git-types';

/* Real isolation for parallel chats: one git worktree + branch per chat. Claude Code's own
   `--worktree` names, places and resumes its worktrees itself (and refuses resumes launched from
   inside them), so the desk creates them with plain git and only reuses the official settings:
   `worktree.symlinkDirectories` and the `baseRef: 'head'` semantics (branch from local HEAD). */

const BRANCH_PREFIX = 'agent-desk/';
const DEFAULT_SYMLINKS = ['node_modules'];
const EXCLUDE_MARK = '# Agent Desk: enlaces de worktrees aislados';

type Run = { code: number; stdout: string; stderr: string };
function run(cwd: string, args: string[], timeout = 30000): Promise<Run> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['--no-pager', ...args],
      {
        cwd,
        env: {
          ...cleanEnv(),
          LC_ALL: 'C',
          GIT_TERMINAL_PROMPT: '0',
          GIT_EDITOR: 'true',
          GIT_MERGE_AUTOEDIT: 'no',
        },
        timeout,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code = (error as (Error & { code?: unknown }) | null)?.code;
        if (error && typeof code !== 'number') reject(error);
        else resolve({ code: typeof code === 'number' ? code : 0, stdout, stderr });
      },
    );
  });
}
async function git(cwd: string, args: string[], timeout?: number) {
  const r = await run(cwd, args, timeout);
  if (r.code)
    throw new Error((r.stderr.trim() || r.stdout.trim() || 'Error de Git.').slice(0, 1200));
  return r.stdout;
}
const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** `worktree` settings of the project, as Claude Code reads them (local overrides shared). */
export function worktreeSettings(...folders: string[]) {
  let symlinkDirectories: string[] | undefined;
  for (const folder of [...new Set(folders)])
    for (const name of ['settings.json', 'settings.local.json']) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(folder, '.claude', name), 'utf8'));
        const value = data?.worktree?.symlinkDirectories;
        if (Array.isArray(value)) symlinkDirectories = value.filter((v) => typeof v === 'string');
      } catch {
        /* missing or invalid settings: keep the default */
      }
    }
  return { symlinkDirectories: symlinkDirectories ?? DEFAULT_SYMLINKS };
}

/** Readable, unique branch suffix: `agent-desk/<title>-<id>`. */
export function worktreeSlug(title: string, id: string) {
  const words = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  const suffix = id
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 8)
    .toLowerCase();
  return words ? `${words}-${suffix}` : suffix;
}

/** Directory for this repository's worktrees, outside the project so they never appear in it. */
export function worktreeHome(dataDir: string, root: string) {
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 10);
  return path.join(dataDir, 'worktrees', `${path.basename(root)}-${hash}`);
}

const inside = (parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

export async function createWorktree(input: {
  project: string;
  dataDir: string;
  title: string;
  id: string;
  /** Start from another worktree's branch (duplicated chat); merges still target `base`. */
  from?: Pick<SessionWorktree, 'branch' | 'base'>;
}): Promise<SessionWorktree> {
  const project = await fs.promises.realpath(input.project);
  const top = await run(project, ['rev-parse', '--show-toplevel']);
  if (top.code) throw new Error('La carpeta del proyecto no es un repositorio Git.');
  const root = await fs.promises.realpath(top.stdout.trim());
  const base =
    input.from?.base ??
    (await run(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
  if (!base)
    throw new Error('La copia principal no está en una rama (HEAD separado). Cambia a una rama.');
  // baseRef 'head': branch from local HEAD so unpushed commits are present.
  const head = await run(root, [
    'rev-parse',
    '--verify',
    input.from ? `refs/heads/${input.from.branch}^{commit}` : 'HEAD',
  ]);
  if (head.code) throw new Error('El repositorio todavía no tiene commits. Crea el primero.');
  const baseCommit = head.stdout.trim();
  const home = worktreeHome(input.dataDir, root);
  await fs.promises.mkdir(home, { recursive: true, mode: 0o700 });
  let slug = worktreeSlug(input.title, input.id);
  for (let n = 2; ; n++) {
    const taken =
      fs.existsSync(path.join(home, slug)) ||
      !(await run(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH_PREFIX}${slug}`]))
        .code;
    if (!taken) break;
    slug = `${worktreeSlug(input.title, input.id)}-${n}`;
  }
  const branch = BRANCH_PREFIX + slug;
  const checkout = path.join(home, slug);
  await git(root, ['worktree', 'add', '-b', branch, '--', checkout, baseCommit], 120000);
  const real = await fs.promises.realpath(checkout);
  const worktree: SessionWorktree = {
    path: real,
    cwd: path.join(real, path.relative(root, project)),
    branch,
    base,
    baseCommit,
    root,
    createdAt: Date.now(),
  };
  try {
    await fs.promises.mkdir(worktree.cwd, { recursive: true });
    await linkDirectories(worktree, project);
  } catch (error) {
    await removeWorktree(worktree).catch(() => {});
    throw error;
  }
  return worktree;
}

/** Symlink heavy untracked folders (node_modules by default) so builds work at once. */
async function linkDirectories(worktree: SessionWorktree, project: string) {
  const { symlinkDirectories } = worktreeSettings(worktree.root, project);
  const candidates = new Set<string>();
  const sub = path.relative(worktree.root, project);
  for (const entry of symlinkDirectories) {
    if (!entry || path.isAbsolute(entry)) continue;
    candidates.add(path.normalize(entry));
    if (sub) candidates.add(path.join(sub, entry));
  }
  const excluded: string[] = [];
  for (const relative of candidates) {
    if (relative.startsWith('..')) continue;
    const source = path.join(worktree.root, relative);
    const target = path.join(worktree.path, relative);
    if (!inside(worktree.root, source) || !inside(worktree.path, target)) continue;
    if (!fs.existsSync(source) || fs.existsSync(target)) continue;
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.symlink(source, target, 'dir');
    // `node_modules/` ignores directories only: a symlink would show up as a new file.
    if ((await run(worktree.path, ['check-ignore', '-q', '--', relative])).code)
      excluded.push('/' + relative.split(path.sep).join('/'));
  }
  if (!excluded.length) return;
  const common = path.resolve(
    worktree.path,
    (await git(worktree.path, ['rev-parse', '--git-common-dir'])).trim(),
  );
  const file = path.join(common, 'info', 'exclude');
  const current = fs.existsSync(file) ? await fs.promises.readFile(file, 'utf8') : '';
  const missing = excluded.filter((line) => !current.split('\n').includes(line));
  if (!missing.length) return;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const prefix = current && !current.endsWith('\n') ? '\n' : '';
  const mark = current.includes(EXCLUDE_MARK) ? '' : `${EXCLUDE_MARK}\n`;
  await fs.promises.appendFile(file, `${prefix}${mark}${missing.join('\n')}\n`);
}

export async function worktreeStatus(worktree: SessionWorktree): Promise<WorktreeStatus> {
  const status: WorktreeStatus = {
    exists: fs.existsSync(path.join(worktree.path, '.git')),
    branch: worktree.branch,
    base: worktree.base,
    ahead: 0,
    behind: 0,
    dirty: 0,
    conflicts: 0,
  };
  status.mainBranch =
    (await run(worktree.root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim() ||
    undefined;
  if (!status.exists) return status;
  const files = (await git(worktree.path, ['status', '--porcelain=v1', '--untracked-files=all']))
    .split('\n')
    .filter(Boolean);
  status.dirty = files.length;
  status.conflicts = files.filter((f) =>
    ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(f.slice(0, 2)),
  ).length;
  const counts = await run(worktree.path, [
    'rev-list',
    '--left-right',
    '--count',
    `HEAD...refs/heads/${worktree.base}`,
  ]);
  if (!counts.code) {
    const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
    status.ahead = ahead || 0;
    status.behind = behind || 0;
  }
  return status;
}

/** Commit everything the agent left in the worktree so it can be merged. */
export async function commitWorktree(worktree: SessionWorktree, message: string) {
  if (!lines(await git(worktree.path, ['status', '--porcelain=v1'])).length) return false;
  await git(worktree.path, ['add', '--all', '--', '.']);
  await git(worktree.path, ['commit', '-m', message]);
  return true;
}

/** Files that would conflict merging `branch` into `base`, without touching any checkout. */
export async function mergeConflicts(root: string, base: string, branch: string) {
  const r = await run(root, [
    'merge-tree',
    '--write-tree',
    '--name-only',
    '--no-messages',
    `refs/heads/${base}`,
    `refs/heads/${branch}`,
  ]);
  if (r.code === 0) return [];
  if (r.code === 1) return [...new Set(lines(r.stdout).slice(1))];
  throw new Error((r.stderr.trim() || 'No se han podido comprobar los conflictos.').slice(0, 1200));
}

async function assertBase(worktree: SessionWorktree) {
  const current = (
    await run(worktree.root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  ).stdout.trim();
  if (current !== worktree.base)
    throw new Error(
      `La copia principal está en ${current || 'un HEAD separado'}. Cambia a ${worktree.base} para fusionar.`,
    );
}

export async function mergeWorktree(
  worktree: SessionWorktree,
  title: string,
): Promise<WorktreeMergeResult> {
  if (!fs.existsSync(path.join(worktree.path, '.git')))
    throw new Error('El worktree ya no existe. Descártalo para limpiar la rama.');
  await assertBase(worktree);
  const status = await worktreeStatus(worktree);
  if (status.conflicts) throw new Error('Resuelve los conflictos del worktree antes de fusionar.');
  const main = lines(
    await git(worktree.root, ['status', '--porcelain=v1', '--untracked-files=no']),
  );
  if (main.length)
    throw new Error(
      `La copia principal tiene ${main.length} archivos con cambios sin commit. Haz commit o guárdalos antes de fusionar.`,
    );
  await commitWorktree(worktree, `Agent Desk: ${title}`.slice(0, 200));
  const counts = (
    await git(worktree.root, [
      'rev-list',
      '--count',
      `refs/heads/${worktree.base}..refs/heads/${worktree.branch}`,
    ])
  ).trim();
  if (counts === '0')
    return { merged: false, upToDate: true, message: `${worktree.base} ya incluye estos cambios.` };
  const conflicts = await mergeConflicts(worktree.root, worktree.base, worktree.branch);
  if (conflicts.length)
    return {
      merged: false,
      conflicts,
      message: `La fusión en ${worktree.base} tendría conflictos en ${conflicts.length} archivos. No se ha modificado la copia principal.`,
    };
  const merge = await run(
    worktree.root,
    [
      'merge',
      '--no-ff',
      '--no-edit',
      '-m',
      `Fusiona ${worktree.branch} (${title})`.slice(0, 200),
      `refs/heads/${worktree.branch}`,
    ],
    120000,
  );
  if (merge.code) {
    // Untracked files in the way or a hook: leave the main checkout as it was.
    await run(worktree.root, ['merge', '--abort']);
    throw new Error((merge.stderr.trim() || merge.stdout.trim()).slice(0, 1200));
  }
  const commit = (await git(worktree.root, ['rev-parse', '--short', 'HEAD'])).trim();
  return { merged: true, commit, message: `Fusionado en ${worktree.base} (${commit}).` };
}

/** Bring the base branch into the worktree; conflicts stay there for the agent to resolve. */
export async function updateWorktree(
  worktree: SessionWorktree,
  title: string,
): Promise<WorktreeMergeResult> {
  if (!fs.existsSync(path.join(worktree.path, '.git')))
    throw new Error('El worktree ya no existe.');
  if ((await worktreeStatus(worktree)).conflicts)
    throw new Error('Resuelve primero los conflictos pendientes del worktree.');
  await commitWorktree(worktree, `Agent Desk: ${title}`.slice(0, 200));
  const merge = await run(
    worktree.path,
    ['merge', '--no-edit', `refs/heads/${worktree.base}`],
    120000,
  );
  if (!merge.code) {
    const upToDate = /Already up to date/i.test(merge.stdout);
    return {
      merged: !upToDate,
      upToDate,
      message: upToDate
        ? `El worktree ya incluye ${worktree.base}.`
        : `Cambios de ${worktree.base} incorporados al worktree.`,
    };
  }
  const conflicts = lines(
    (await run(worktree.path, ['diff', '--name-only', '--diff-filter=U'])).stdout,
  );
  if (!conflicts.length) {
    await run(worktree.path, ['merge', '--abort']);
    throw new Error((merge.stderr.trim() || merge.stdout.trim()).slice(0, 1200));
  }
  return {
    merged: false,
    conflicts,
    message: `Hay conflictos en ${conflicts.length} archivos del worktree. Pide al agente que los resuelva y haga commit.`,
  };
}

/** Remove the checkout and its branch. Unmerged work is lost: the UI confirms first. */
export async function removeWorktree(worktree: SessionWorktree) {
  if (!worktree.branch.startsWith(BRANCH_PREFIX))
    throw new Error('Esta rama no pertenece a un worktree de Agent Desk.');
  if (fs.existsSync(worktree.path)) {
    const r = await run(worktree.root, ['worktree', 'remove', '--force', '--', worktree.path]);
    if (r.code && fs.existsSync(worktree.path))
      await fs.promises.rm(worktree.path, { recursive: true, force: true });
  }
  await run(worktree.root, ['worktree', 'prune']);
  const exists = !(
    await run(worktree.root, ['rev-parse', '--verify', '--quiet', `refs/heads/${worktree.branch}`])
  ).code;
  if (exists) await git(worktree.root, ['branch', '-D', '--', worktree.branch]);
}
