import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cleanEnv } from './core';
import { scorePath } from './project-files';
import type {
  WorkspaceFileEntry,
  WorkspaceFileResult,
  WorkspaceFilesResult,
  WorkspaceDiffResult,
} from '../src/workspace-files';

const exec = promisify(execFile);
const MAX_CONTENT = 256 * 1024;
const MAX_DIFF = 1024 * 1024;
const MAX_ENTRIES = 1000;
const MAX_SCAN = 20000;
const SKIP_SEARCH = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-electron',
  '.next',
  '.cache',
  '.venv',
  'vendor',
  'coverage',
  '__pycache__',
]);
const inside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};

/** All panel paths share the checkout root. Never follow project symlinks or expose .git. */
export async function resolveWorkspacePath(root: string, input = '', allowMissing = false) {
  root = await fs.realpath(root);
  if (input.includes('\0')) throw new Error('Ruta de archivo no válida.');
  const target = path.resolve(root, input);
  if (!inside(root, target)) throw new Error('El archivo está fuera del proyecto.');
  const relative = path.relative(root, target);
  const parts = relative.split(path.sep).filter(Boolean);
  if (parts.some((part) => part.toLowerCase() === '.git'))
    throw new Error('Los archivos internos de Git no se muestran.');
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Los enlaces simbólicos se abren desde Finder.');
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  return { root, target, relative: relative.split(path.sep).join('/') };
}

export async function listWorkspaceFiles(
  root: string,
  directory = '',
  query = '',
): Promise<WorkspaceFilesResult> {
  const resolved = await resolveWorkspacePath(root, directory);
  if (!(await fs.stat(resolved.target)).isDirectory())
    throw new Error('La ruta no es una carpeta.');
  const entries: WorkspaceFileEntry[] = [];
  const queue = [resolved.relative];
  const searching = !!query.trim();
  let scanned = 0,
    truncated = false;
  while (queue.length && scanned < MAX_SCAN && entries.length < MAX_ENTRIES) {
    const dir = queue.shift()!;
    let handle;
    try {
      const checked = await resolveWorkspacePath(resolved.root, dir);
      handle = await fs.opendir(checked.target);
    } catch (error) {
      if (!searching) throw error;
      continue;
    }
    for await (const entry of handle) {
      scanned++;
      if (scanned > MAX_SCAN) {
        truncated = true;
        break;
      }
      if (entry.name.toLowerCase() === '.git' || entry.isSymbolicLink()) continue;
      const relative = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (searching) {
          if (!SKIP_SEARCH.has(entry.name)) queue.push(relative);
        } else entries.push({ path: relative, name: entry.name, kind: 'directory' });
      } else if (entry.isFile() && (!searching || scorePath(relative, query.trim()) > 0)) {
        entries.push({ path: relative, name: entry.name, kind: 'file' });
      }
      if (scanned >= MAX_SCAN || entries.length >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
    }
  }
  entries.sort((a, b) =>
    searching
      ? scorePath(b.path, query.trim()) - scorePath(a.path, query.trim()) ||
        a.path.localeCompare(b.path)
      : Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
        a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
  return { root: resolved.root, entries, truncated: truncated || queue.length > 0 };
}

async function resolveFileReference(root: string, input: string) {
  let raw = input.trim();
  if (/^file:/i.test(raw)) {
    try {
      raw = fileURLToPath(raw);
    } catch {
      throw new Error('Ruta de archivo no válida.');
    }
  }
  if (/^~(?:\/|$)/.test(raw)) raw = path.join(os.homedir(), raw.slice(2));
  // Prefer exact filenames, which may legitimately contain colons or #L suffixes.
  const candidates = [
    raw,
    raw.replace(/#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/i, ''),
    raw.replace(/(?::\d+){1,2}$/, ''),
  ];
  let missing: unknown;
  for (const candidate of new Set(candidates)) {
    try {
      return await resolveWorkspacePath(root, candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing = error;
    }
  }
  throw missing;
}

export async function readWorkspaceFile(root: string, input: string): Promise<WorkspaceFileResult> {
  const resolved = await resolveFileReference(root, input);
  if (!(await fs.lstat(resolved.target)).isFile())
    throw new Error('Selecciona un archivo para ver su contenido.');
  const handle = await fs.open(
    resolved.target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Selecciona un archivo para ver su contenido.');
    // Recheck the ancestry after opening, before reading bytes, to catch replaced directories.
    const checked = await resolveWorkspacePath(root, resolved.target);
    const current = await fs.stat(checked.target);
    if (current.ino !== stat.ino || current.dev !== stat.dev)
      throw new Error('El archivo cambió al abrirse. Vuelve a intentarlo.');
    const bytes = Buffer.alloc(Math.min(stat.size, MAX_CONTENT));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const data = bytes.subarray(0, bytesRead);
    let content = '',
      binary = data.includes(0);
    if (!binary) {
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(data, {
          stream: stat.size > MAX_CONTENT,
        });
      } catch {
        binary = true;
      }
    }
    return {
      root: resolved.root,
      path: resolved.relative,
      content: binary ? '' : content,
      language: path.extname(resolved.relative).slice(1) || undefined,
      size: stat.size,
      binary,
      truncated: stat.size > bytesRead,
    };
  } finally {
    await handle.close();
  }
}

async function git(root: string, args: string[], allowDifferent = false, limit = MAX_DIFF) {
  try {
    const result = await exec('git', ['--no-pager', '--literal-pathspecs', ...args], {
      cwd: root,
      env: { ...cleanEnv(), LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      timeout: 15000,
      maxBuffer: limit,
    });
    return { text: result.stdout, truncated: false };
  } catch (error) {
    const value = error as Error & { code?: string | number; stdout?: string; stderr?: string };
    if (value.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      return { text: (value.stdout ?? '').slice(0, limit), truncated: true };
    if (allowDifferent && value.code === 1) return { text: value.stdout ?? '', truncated: false };
    throw new Error((value.stderr?.trim() || value.message).slice(0, 1200));
  }
}
async function change(root: string, file: string) {
  const output = await git(
    root,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    false,
    8 * MAX_DIFF,
  );
  if (output.truncated) throw new Error('La lista de cambios supera el tamaño admitido.');
  const records = output.text.split('\0');
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    const status = row.slice(0, 2),
      name = row.slice(3);
    const original = /[RC]/.test(status) ? records[++i] : undefined;
    if (name === file) return { status, original };
  }
}
export async function readWorkspaceDiff(
  root: string,
  input: string,
  staged: boolean,
): Promise<WorkspaceDiffResult> {
  const file = await resolveWorkspacePath(root, input, true);
  if (!file.relative) throw new Error('Selecciona un archivo.');
  try {
    if (!(await fs.lstat(file.target)).isFile())
      throw new Error('Selecciona un archivo para revisar sus cambios.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const status = await change(file.root, file.relative);
  const paths = [file.relative];
  if (status?.original)
    paths.push((await resolveWorkspacePath(file.root, status.original, true)).relative);
  const output =
    !staged && status?.status === '??'
      ? await git(
          file.root,
          [
            'diff',
            '--no-index',
            '--no-ext-diff',
            '--no-textconv',
            '--',
            '/dev/null',
            file.relative,
          ],
          true,
        )
      : await git(file.root, [
          'diff',
          ...(staged ? ['--cached'] : []),
          '--no-ext-diff',
          '--no-textconv',
          '--',
          ...paths,
        ]);
  return {
    root: file.root,
    path: file.relative,
    filePath: file.relative,
    patch: output.text,
    binary: /^(Binary files |GIT binary patch)/m.test(output.text),
    truncated: output.truncated,
  };
}
export async function stageWorkspaceFile(root: string, input: string, staged: boolean) {
  const file = await resolveWorkspacePath(root, input, true);
  if (!file.relative) throw new Error('Selecciona un archivo.');
  const status = await change(file.root, file.relative);
  if (!status) throw new Error('El archivo ya no tiene cambios. Actualiza la lista.');
  try {
    if (!(await fs.lstat(file.target)).isFile())
      throw new Error('Solo se puede preparar un archivo cada vez.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const paths = [file.relative];
  if (status.original)
    paths.push((await resolveWorkspacePath(file.root, status.original, true)).relative);
  let args: string[];
  if (staged) args = ['add', '--all', '--', ...paths];
  else {
    const hasHead = await git(file.root, ['rev-parse', '--verify', 'HEAD']).then(
      () => true,
      () => false,
    );
    args = hasHead
      ? ['restore', '--staged', '--', ...paths]
      : ['rm', '--cached', '--force', '--ignore-unmatch', '--', ...paths];
  }
  await git(file.root, args);
  return true;
}
