import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { cleanEnv } from './core';
const exec = promisify(execFile);
const MAX_FILES = 40000;
const CACHE_MS = 20000;
const SKIP = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-electron',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
  'target',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  'Pods',
  'DerivedData',
]);
// Only plain-text formats are handed to the default app; anything else is revealed in Finder.
const TEXT = new Set(
  (
    'md mdx txt rst adoc json jsonc json5 yaml yml toml ini cfg conf env csv tsv log xml svg html htm ' +
    'css scss sass less js jsx mjs cjs ts tsx mts cts vue svelte astro py rb go rs java kt kts swift ' +
    'c h cc cpp hpp m mm cs fs php lua pl r sql graphql gql proto prisma dart scala ex exs erl hs ' +
    'clj zig nim tf hcl gradle properties lock gitignore dockerignore editorconfig prettierrc'
  ).split(' '),
);
const cache = new Map<string, { at: number; files: Promise<string[]> }>();
async function walk(root: string) {
  const files: string[] = [];
  const queue = [''];
  while (queue.length && files.length < MAX_FILES) {
    const dir = queue.shift()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name) && !entry.name.startsWith('.')) queue.push(rel);
      } else if (entry.isFile()) files.push(rel);
      if (files.length >= MAX_FILES) break;
    }
  }
  return files;
}
async function gitFiles(root: string) {
  const { stdout } = await exec(
    'git',
    ['--no-pager', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: root,
      env: { ...cleanEnv(), LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      timeout: 8000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return stdout.split('\0').filter(Boolean).slice(0, MAX_FILES);
}
/** Project files relative to the root: Git's view when available, otherwise a bounded walk. */
export function projectFiles(root: string) {
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.files;
  const files = gitFiles(root).catch(() => walk(root));
  cache.set(root, { at: Date.now(), files });
  files.catch(() => cache.delete(root));
  return files;
}
/** Subsequence match favouring file names, contiguous runs and short paths. */
export function scorePath(file: string, query: string) {
  if (!query) return 1;
  const q = query.toLowerCase();
  const p = file.toLowerCase();
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (base === q) return 1000;
  let score = 0,
    from = 0,
    run = 0;
  for (const ch of q) {
    const at = p.indexOf(ch, from);
    if (at < 0) return 0;
    run = at === from ? run + 1 : 0;
    score += 1 + run * 2 + (at === 0 || '/._-'.includes(p[at - 1]) ? 3 : 0);
    from = at + 1;
  }
  if (base.includes(q)) score += 40 + (base.startsWith(q) ? 20 : 0);
  else if (p.includes(q)) score += 15;
  return score - p.length / 50;
}
export async function searchProjectFiles(root: string, query: string, limit = 30) {
  const q = query.trim().replace(/^\.\//, '');
  const files = await projectFiles(root);
  return files
    .map((file) => ({ file, score: scorePath(file, q) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.file.length - b.file.length)
    .slice(0, limit)
    .map((r) => r.file);
}
const inside = (root: string, target: string) => {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
/**
 * Resolve a path mentioned in the chat (absolute, relative, file:line, #L10) to an existing
 * entry inside the project. Symlinks are resolved before the containment check.
 */
export async function resolveProjectPath(root: string, input: string) {
  const raw = input.trim().replace(/^file:\/\//i, '');
  const candidates = [
    raw,
    raw.replace(/#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/i, ''),
    raw.replace(/(?::\d+){1,2}$/, ''),
  ];
  const realRoot = await fs.realpath(root);
  for (const candidate of new Set(candidates)) {
    // Home-relative paths are never resolved against the project.
    if (!candidate || /^~(?:\/|$)/.test(candidate)) continue;
    try {
      const real = await fs.realpath(path.resolve(root, candidate));
      if (!inside(realRoot, real)) continue;
      const stat = await fs.stat(real);
      return { path: real, directory: stat.isDirectory() };
    } catch {
      /* try the next spelling */
    }
  }
  throw new Error('El archivo no existe dentro del proyecto.');
}
export function opensAsText(file: string) {
  const name = path.basename(file).toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  return TEXT.has(ext) || /^(readme|license|makefile|dockerfile|procfile|gemfile)$/.test(name);
}
