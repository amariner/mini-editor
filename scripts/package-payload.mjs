import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Renderer packages and bundled main-process imports are already in dist. Only
// external runtime packages and their actual installed dependency graph belong here.
export const runtimePackages = [
  'node-pty',
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/claude-code',
  '@google/gemini-cli',
  '@opencode/cli',
];

function supports(values, current) {
  return (
    !values ||
    (!values.includes(`!${current}`) &&
      (!values.some((value) => !value.startsWith('!')) || values.includes(current)))
  );
}

export async function runtimeDependencies(root, names = runtimePackages, target = process) {
  const selected = new Map();
  const moduleRoot = path.join(await fs.realpath(root), 'node_modules') + path.sep;
  async function resolve(from, name) {
    let directory = from;
    while (directory === root || directory.startsWith(root + path.sep)) {
      const candidate = path.join(directory, 'node_modules', name);
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(candidate, 'package.json'), 'utf8'));
        const real = await fs.realpath(candidate);
        if (!real.startsWith(moduleRoot)) throw new Error(`Dependencia externa: ${real}`);
        return { source: candidate, pkg };
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      }
      if (directory === root) break;
      directory = path.dirname(directory);
    }
  }
  async function visit(from, name, optional = false) {
    const resolved = await resolve(from, name);
    if (!resolved) {
      if (optional) return;
      throw new Error(`Falta dependencia de ejecución: ${name} (desde ${from})`);
    }
    const { source, pkg } = resolved;
    if (!supports(pkg.os, target.platform) || !supports(pkg.cpu, target.arch)) {
      if (optional) return;
      throw new Error(`Dependencia incompatible con ${target.platform}-${target.arch}: ${name}`);
    }
    if (selected.has(source)) return;
    selected.set(source, pkg);
    const required = { ...pkg.dependencies, ...pkg.peerDependencies };
    for (const dependency of Object.keys(required)) {
      await visit(
        source,
        dependency,
        !!pkg.optionalDependencies?.[dependency] ||
          !!pkg.peerDependenciesMeta?.[dependency]?.optional,
      );
    }
    for (const dependency of Object.keys(pkg.optionalDependencies ?? {})) {
      if (!(dependency in required)) await visit(source, dependency, true);
    }
  }
  for (const name of names) await visit(root, name);
  return [...selected].map(([source, pkg]) => ({ source, pkg }));
}

export function runtimeFile(packageName, relative, target = process) {
  if (!relative) return true;
  const parts = relative.split(path.sep);
  // Each selected nested package is copied separately, with its own policy.
  if (parts[0] === 'node_modules') return false;
  if (parts.some((part) => ['.cache', '.git', '.DS_Store'].includes(part))) return false;
  if (/\.(?:[cm]?js|css)\.map$/.test(relative) || /\.d\.[cm]?ts(?:\.map)?$/.test(relative))
    return false;
  if (packageName === 'node-pty') {
    if (['src', 'scripts', 'deps', 'third_party', 'typings', 'binding.gyp'].includes(parts[0]))
      return false;
    if (/\.(?:test|spec)\.js$/.test(relative)) return false;
    // node-gyp leaves object files, Makefiles and even absolute Python symlinks
    // here. Only the native runtime and its spawn helper belong in the app.
    if (parts[0] === 'build') {
      if (parts.length === 1) return true;
      if (!['Release', 'Debug'].includes(parts[1])) return false;
      if (parts.length === 2) return true;
      return (
        parts.length === 3 &&
        (parts[2] === 'spawn-helper' || /\.(?:node|dll|exe|dylib|so)$/.test(parts[2]))
      );
    }
  }
  if (
    ['node-pty', '@github/keytar'].includes(packageName) &&
    parts[0] === 'prebuilds' &&
    parts[1]
  ) {
    return parts[1] === `${target.platform}-${target.arch}`;
  }
  return true;
}

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// npm's native CLI installers create hardlinks. fs.cp does not preserve those,
// so copying every package used to ship Claude three times and OpenCode twice.
// Relative symlinks survive ditto, DMG creation and a move to /Applications.
// Compare the complete bytes before deduplicating: future SDK/CLI versions may differ.
export async function deduplicateBinaries(payload, target = process) {
  const groups = [
    [
      '@anthropic-ai/claude-code/bin/claude.exe',
      `@anthropic-ai/claude-code-${target.platform}-${target.arch}/claude`,
      `@anthropic-ai/claude-agent-sdk-${target.platform}-${target.arch}/claude`,
    ],
    [
      '@opencode/cli/bin/opencode.exe',
      `@opencode/cli-${target.platform}-${target.arch}/bin/opencode`,
      `@opencode/cli-${target.platform}-${target.arch}-baseline/bin/opencode`,
    ],
  ];
  let savedBytes = 0;
  const links = [];
  for (const group of groups) {
    const canonical = path.join(payload, 'node_modules', group[0]);
    const original = await fs.stat(canonical);
    const originalHash = await digest(canonical);
    for (const relative of group.slice(1)) {
      const file = path.join(payload, 'node_modules', relative);
      let stat;
      try {
        stat = await fs.lstat(file);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (!stat.isFile() || stat.size !== original.size || (await digest(file)) !== originalHash)
        continue;
      await fs.unlink(file);
      await fs.symlink(path.relative(path.dirname(file), canonical), file);
      savedBytes += stat.size;
      links.push(relative);
    }
  }
  return { savedBytes, links };
}

export async function payloadSize(directory) {
  let bytes = 0;
  let files = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await payloadSize(file);
      bytes += nested.bytes;
      files += nested.files;
    } else {
      const stat = await fs.lstat(file);
      bytes += stat.size;
      files++;
    }
  }
  return { bytes, files };
}
