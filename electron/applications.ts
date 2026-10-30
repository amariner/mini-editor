import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import type { ApplicationInfo, ApplicationSnapshot } from '../src/applications-types';

const execute = promisify(execFile);
const utilityEnvironment = () => ({
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  HOME: os.homedir(),
  LANG: 'en_US.UTF-8',
});
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  );
};
const appId = (file: string) => createHash('sha256').update(file).digest('hex').slice(0, 24);
type BundleMetadata = Record<string, unknown>;
type Options = {
  changed: () => void;
  home?: string;
  roots?: string[];
  platform?: NodeJS.Platform;
  pathEnvironment?: string;
  /** Test seams: never supplied by IPC or by a web page. */
  readMetadata?: (file: string) => Promise<BundleMetadata>;
  copyBundle?: (source: string, destination: string) => Promise<void>;
};

async function readMetadata(file: string): Promise<BundleMetadata> {
  const { stdout } = await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], {
    timeout: 5000,
    maxBuffer: 1024 * 1024,
    env: utilityEnvironment(),
  });
  return JSON.parse(stdout);
}

const text = (value: unknown, max = 200) =>
  typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max) : undefined;

/** Checks bundle structure without launching code from the application being inspected. */
export async function validateApplicationBundle(requested: string, metadataReader = readMetadata) {
  if (!path.isAbsolute(requested) || !/\.app$/i.test(requested) || requested.includes('\0'))
    throw new Error('Selecciona una aplicación .app, no un instalador .pkg o .dmg.');
  const file = await fs.realpath(requested);
  if (!(await fs.stat(file)).isDirectory())
    throw new Error('La aplicación no es una carpeta .app válida.');
  const info = path.join(file, 'Contents', 'Info.plist');
  if (!inside(file, await fs.realpath(info))) throw new Error('Info.plist sale de la aplicación.');
  const metadata = await metadataReader(info);
  const executable = metadata.CFBundleExecutable;
  if (
    typeof executable !== 'string' ||
    !executable ||
    executable === '.' ||
    executable === '..' ||
    /[/\\\0]/.test(executable)
  )
    throw new Error('La aplicación no declara un ejecutable válido.');
  const executablePath = path.join(file, 'Contents', 'MacOS', executable);
  const resolvedExecutable = await fs.realpath(executablePath);
  if (!inside(file, resolvedExecutable) || !(await fs.stat(resolvedExecutable)).isFile())
    throw new Error('El ejecutable debe pertenecer a la aplicación.');
  await fs.access(resolvedExecutable, constants.X_OK);
  return {
    file,
    executablePath,
    name:
      text(metadata.CFBundleDisplayName) ||
      text(metadata.CFBundleName) ||
      path.basename(requested, '.app'),
    version: text(metadata.CFBundleShortVersionString, 80) || text(metadata.CFBundleVersion, 80),
    bundleId: text(metadata.CFBundleIdentifier),
  };
}

/** Relative framework links are common in .app bundles; links outside the bundle are not copied. */
async function validateBundleTree(root: string) {
  root = await fs.realpath(root);
  let count = 0;
  async function walk(directory: string) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (++count > 200000)
        throw new Error('La aplicación contiene demasiados archivos para instalarla aquí.');
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await fs.readlink(file);
        if (path.isAbsolute(target) || !inside(root, await fs.realpath(file)))
          throw new Error(
            'La aplicación contiene enlaces fuera de su carpeta. Usa su instalador oficial.',
          );
      } else if (entry.isDirectory()) await walk(file);
      else if (!entry.isFile())
        throw new Error(
          'La aplicación contiene un archivo especial que no se puede instalar aquí.',
        );
    }
  }
  await walk(root);
}

export class UserApplications {
  private readonly home: string;
  private readonly roots: string[];
  private readonly platform: NodeJS.Platform;
  private readonly metadataReader: typeof readMetadata;
  private state: ApplicationSnapshot;
  private refreshing?: Promise<ApplicationSnapshot>;
  private installing = false;

  constructor(private options: Options) {
    this.home = options.home ?? os.homedir();
    this.platform = options.platform ?? process.platform;
    this.roots = options.roots ?? [
      path.join(this.home, 'Applications'),
      path.join(this.home, 'Aplicaciones'),
      '/Applications',
      '/System/Applications',
    ];
    this.metadataReader = options.readMetadata ?? readMetadata;
    this.state = {
      items: [],
      supported: this.platform === 'darwin',
      installDirectory: path.join(this.home, 'Applications'),
    };
  }

  snapshot(): ApplicationSnapshot {
    return {
      ...this.state,
      items: this.state.items.map((item) => ({ ...item, capabilities: [...item.capabilities] })),
    };
  }

  private changed(patch: Partial<ApplicationSnapshot>) {
    Object.assign(this.state, patch);
    this.options.changed();
  }

  async refresh() {
    if (this.installing) return this.snapshot();
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.scan();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }

  private async scan() {
    this.changed({ busy: 'refreshing', error: undefined });
    try {
      const items: ApplicationInfo[] = [];
      const seen = new Set<string>();
      const directories =
        this.platform === 'darwin' ? this.roots.map((file) => ({ file, depth: 0 })) : [];
      let checked = 0;
      while (directories.length && checked < 1000) {
        const { file, depth } = directories.shift()!;
        const entries = await fs.readdir(file, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (entry.name.startsWith('.') || !entry.isDirectory() || ++checked > 1000) continue;
          const candidate = path.join(file, entry.name);
          if (!/\.app$/i.test(entry.name)) {
            if (depth < 2) directories.push({ file: candidate, depth: depth + 1 });
            continue;
          }
          try {
            const app = await validateApplicationBundle(candidate, this.metadataReader);
            if (seen.has(app.file)) continue;
            seen.add(app.file);
            const capabilities = ['Abrir', 'Mostrar en Finder'];
            if (app.bundleId === 'com.google.Chrome')
              capabilities.push('Control de navegador disponible');
            items.push({
              id: appId(app.file),
              path: app.file,
              name: app.name,
              kind: 'app',
              scope: inside(this.home, candidate) ? 'user' : 'system',
              version: app.version,
              bundleId: app.bundleId,
              capabilities,
            });
          } catch {
            /* Broken or non-application bundles do not prevent discovery. */
          }
        }
      }
      const cliDirectories = [
        ...new Set(
          [
            ...(this.options.pathEnvironment ?? process.env.PATH ?? '').split(path.delimiter),
            ...[
              '.local/bin',
              '.npm-global/bin',
              '.npm/bin',
              '.volta/bin',
              '.cargo/bin',
              '.bun/bin',
              '.asdf/shims',
              '.local/share/mise/shims',
              'Library/pnpm',
            ].map((dir) => path.join(this.home, dir)),
            '/opt/homebrew/bin',
            '/usr/local/bin',
            '/usr/bin',
          ].filter((dir) => path.isAbsolute(dir)),
        ),
      ];
      for (const command of [
        'codex',
        'claude',
        'gemini',
        'opencode',
        'git',
        'gh',
        'node',
        'npm',
        'python3',
        'uv',
        'brew',
        'ollama',
      ]) {
        for (const directory of cliDirectories) {
          const file = path.join(directory, command);
          try {
            if (!(await fs.stat(file)).isFile()) continue;
            await fs.access(file, constants.X_OK);
            const canonical = await fs.realpath(file);
            if (seen.has(canonical)) continue;
            seen.add(canonical);
            items.push({
              id: appId(file),
              name: command,
              path: file,
              kind: 'cli',
              scope: inside(this.home, file) ? 'user' : 'system',
              capabilities: ['Línea de comandos', 'Mostrar en Finder'],
            });
            break;
          } catch {
            /* Try the next user or system installation. */
          }
        }
      }
      items.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'es'));
      this.changed({ items, updatedAt: Date.now(), busy: undefined });
      return this.snapshot();
    } catch (error) {
      this.changed({ busy: undefined, error: (error as Error).message });
      throw error;
    }
  }

  private item(id: string) {
    const item = this.state.items.find((item) => item.id === id);
    if (!item) throw new Error('La aplicación ya no está en el inventario. Actualiza la lista.');
    return item;
  }

  async open(id: string) {
    const item = this.item(id);
    if (this.platform !== 'darwin' || item.kind !== 'app')
      throw new Error('Abre las herramientas CLI desde el terminal del proyecto.');
    await validateApplicationBundle(item.path, this.metadataReader);
    await execute('/usr/bin/open', ['-a', item.path], {
      timeout: 15000,
      maxBuffer: 65536,
      env: utilityEnvironment(),
    });
    return { ok: true };
  }

  async reveal(id: string) {
    const item = this.item(id);
    if (this.platform !== 'darwin')
      throw new Error('Mostrar aplicaciones está disponible en macOS.');
    await fs.access(item.path);
    await execute('/usr/bin/open', ['-R', item.path], {
      timeout: 15000,
      maxBuffer: 65536,
      env: utilityEnvironment(),
    });
    return { ok: true };
  }

  async install(source: string) {
    if (this.platform !== 'darwin')
      throw new Error('La instalación de aplicaciones .app está disponible en macOS.');
    if (this.installing) throw new Error('Ya se está instalando una aplicación.');
    this.installing = true;
    let staging: string | undefined;
    let destination: string | undefined;
    let reservation: Awaited<ReturnType<typeof fs.stat>> | undefined;
    let installed = false;
    try {
      if (this.refreshing) await this.refreshing;
      this.changed({ busy: 'installing', error: undefined, lastInstalled: undefined });
      const bundle = await validateApplicationBundle(source, this.metadataReader);
      await validateBundleTree(bundle.file);
      const home = await fs.realpath(this.home);
      const directory = this.state.installDirectory;
      await fs.mkdir(directory, { recursive: true, mode: 0o755 });
      if (
        (await fs.lstat(directory)).isSymbolicLink() ||
        path.dirname(await fs.realpath(directory)) !== home
      )
        throw new Error('La carpeta Applications debe estar dentro de tu carpeta de usuario.');
      destination = path.join(directory, path.basename(source));
      // Reserve the name exclusively; existing applications are never updated or replaced.
      await fs.mkdir(destination, { mode: 0o755 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST')
          throw new Error(
            'Ya existe una aplicación con ese nombre en tu carpeta Applications. No se ha reemplazado.',
          );
        throw error;
      });
      reservation = await fs.stat(destination);
      staging = await fs.mkdtemp(path.join(directory, '.agent-desk-install-'));
      const prepared = path.join(staging, path.basename(source));
      if (this.options.copyBundle) await this.options.copyBundle(bundle.file, prepared);
      else
        await execute(
          '/usr/bin/ditto',
          ['--rsrc', '--extattr', '--qtn', '--acl', bundle.file, prepared],
          { timeout: 300000, maxBuffer: 1024 * 1024, env: utilityEnvironment() },
        );
      await validateApplicationBundle(prepared, this.metadataReader);
      await validateBundleTree(prepared);
      const current = await fs.lstat(destination);
      if (
        current.ino !== reservation.ino ||
        current.dev !== reservation.dev ||
        !current.isDirectory() ||
        (await fs.readdir(destination)).length
      )
        throw new Error(
          'La carpeta de destino cambió durante la instalación. No se ha reemplazado.',
        );
      // Both directories are on the same filesystem. Publish a complete bundle atomically
      // over our own empty reservation; rename refuses an occupied destination directory.
      await fs.rename(prepared, destination);
      installed = true;
      this.changed({ lastInstalled: destination });
      return { ok: true, path: destination, name: bundle.name };
    } catch (error) {
      this.changed({ error: (error as Error).message });
      throw error;
    } finally {
      if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      if (!installed && destination && reservation) {
        const current = await fs.lstat(destination).catch(() => undefined);
        if (current?.ino === reservation.ino && current.dev === reservation.dev)
          await fs.rmdir(destination).catch(() => {});
      }
      this.installing = false;
      this.changed({ busy: undefined });
      if (installed) await this.refresh().catch(() => {});
    }
  }
}
