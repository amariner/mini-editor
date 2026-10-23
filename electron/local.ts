import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { promisify } from 'node:util';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { OpenRouterService, type ProviderServices } from './openrouter';
import { cleanEnv, profileDirectory } from './core';
import type { Profile, ModelInfo } from '../src/shared';

export interface LocalConfig {
  directory?: string;
  context: number;
  tools: boolean;
  defaultModel?: string;
  cacheType?: 'q8_0' | 'q4_0';
}
export interface LocalState extends LocalConfig {
  engine: boolean;
  running?: string;
  busy?: string;
  downloaded: number;
  total?: number;
  runningContext?: number;
  outputLimit: number;
}
const version = 'b11819';
const digest = '4f1c12d98435b335338bba0204dbeb91d91a07a25d50f464cd54cd73de093bcc';
const runFile = promisify(execFile);
async function macPressure() {
  if (process.platform !== 'darwin') return 0;
  try {
    return Number(
      (
        await runFile('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], {
          timeout: 1000,
        })
      ).stdout.trim(),
    );
  } catch {
    return 0;
  }
}
export function localSwapUsed(text: string): number | undefined {
  const match = text.match(/used\s*=\s*([\d.]+)([KMGT]?)/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  const power = match[2] ? 'KMGT'.indexOf(match[2].toUpperCase()) + 1 : 0;
  return amount * 1024 ** power;
}
async function macSwapUsed(): Promise<number | undefined> {
  if (process.platform !== 'darwin') return undefined;
  try {
    const { stdout } = await runFile('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], { timeout: 1000 });
    return localSwapUsed(stdout);
  } catch {
    return undefined;
  }
}
/** Warning alone may be stable; stop critical pressure or fast swap growth during a warning. */
export class LocalMemoryGuard {
  private warningSince?: number;
  private swapBaseline?: number;
  check(level: number, now = Date.now(), swapUsed?: number): 'critical' | 'sustained' | undefined {
    if (level >= 4) return 'critical';
    if (level < 2) {
      this.warningSince = undefined;
      this.swapBaseline = undefined;
      return;
    }
    if (this.warningSince === undefined) {
      this.warningSince = now;
      this.swapBaseline = swapUsed;
    }
    if (now - this.warningSince >= 30_000) {
      // Fail conservatively if telemetry is unavailable; otherwise allow stable compression/swap.
      if (
        swapUsed === undefined ||
        this.swapBaseline === undefined ||
        swapUsed - this.swapBaseline >= 512 * 1024 ** 2
      )
        return 'sustained';
      this.warningSince = now;
      this.swapBaseline = swapUsed;
    }
  }
}
export const localOutputLimit = (context: number) => Math.min(8192, Math.floor(context / 4));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export function localModelName(value: string) {
  // Persist portable paths relative to the selected library, never absolute paths or traversal.
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 1024 ||
    !/\.gguf$/i.test(value) ||
    /[\\\x00-\x1f:]/.test(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Selecciona un archivo GGUF de la carpeta de modelos.');
  return value;
}
function insideDirectory(directory: string, file: string) {
  const relative = path.relative(directory, file);
  return (
    !!relative &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
async function resolveModel(directory: string, name: string) {
  const root = await fs.realpath(directory);
  const file = path.join(root, localModelName(name));
  const canonical = await fs.realpath(file);
  if (!insideDirectory(root, canonical))
    throw new Error('El modelo está fuera de la carpeta seleccionada.');
  if (!(await fs.stat(canonical)).isFile()) throw new Error('El modelo no es un archivo GGUF.');
  return { file, canonical };
}
async function checkGGUF(file: string) {
  const handle = await fs.open(file, 'r');
  try {
    const magic = Buffer.alloc(4);
    await handle.read(magic, 0, 4, 0);
    if (magic.toString() !== 'GGUF') throw new Error('El archivo no es GGUF.');
  } finally {
    await handle.close();
  }
}
function splitModel(name: string) {
  const match = name.match(/^(.*)-(\d{5})-of-(\d{5})(\.gguf)$/i);
  return match
    ? { prefix: match[1], part: Number(match[2]), total: Number(match[3]), extension: match[4] }
    : undefined;
}
function modelParts(name: string) {
  const split = splitModel(name);
  if (!split) return [name];
  if (split.part !== 1 || split.total < 1)
    throw new Error('Selecciona la primera parte del modelo GGUF (00001).');
  return Array.from(
    { length: split.total },
    (_, i) =>
      `${split.prefix}-${String(i + 1).padStart(5, '0')}-of-${String(split.total).padStart(5, '0')}${split.extension}`,
  );
}
export class LocalService extends OpenRouterService {
  override readonly name = 'Local';
  constructor(
    root: string,
    services: ProviderServices = {},
    private pressure: () => Promise<number> = macPressure,
    private swap: () => Promise<number | undefined> = macSwapUsed,
  ) {
    super(root, services);
  }
  private monitor?: ReturnType<typeof setInterval>;
  private memoryError?: Error;
  private diagnostic = '';
  private child?: ChildProcess;
  private loaded?: string;
  private loadedName?: string;
  private loadedContext?: number;
  private loadedCache?: string;
  private port?: number;
  private token = randomBytes(32).toString('hex');
  private startup?: Promise<void>;
  private active = false;
  private idle?: ReturnType<typeof setTimeout>;
  private job?: Promise<unknown>;
  private controller?: AbortController;
  private progress: { busy?: string; downloaded: number; total?: number } = { downloaded: 0 };
  private enginePath?: string;
  private closing = false;
  get busy() {
    return !!this.job || !!this.startup || this.active;
  }
  private engineDirectory() {
    return path.join(this.root, 'local-engine', version);
  }
  private configPath(profile: Profile) {
    if (!profile.startsWith('local-')) throw new Error('El perfil no es local.');
    return path.join(profileDirectory(this.root, profile), 'local.json');
  }
  async config(profile: Profile): Promise<LocalConfig> {
    try {
      const c = JSON.parse(await fs.readFile(this.configPath(profile), 'utf8'));
      return {
        directory: typeof c.directory === 'string' ? c.directory : undefined,
        context:
          Number.isInteger(c.context) && c.context >= 2048 && c.context <= 131072
            ? c.context
            : 8192,
        tools: c.tools === true,
        cacheType: c.cacheType === 'q4_0' ? 'q4_0' : 'q8_0',
        defaultModel:
          typeof c.defaultModel === 'string' && c.defaultModel ? c.defaultModel : undefined,
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      return { context: 8192, tools: false };
    }
  }
  async configure(profile: Profile, patch: Partial<LocalConfig>) {
    return this.operation('Guardando ajustes locales', async () => {
      if (
        patch.context !== undefined &&
        (!Number.isInteger(patch.context) || patch.context < 2048 || patch.context > 131072)
      )
        throw new Error('El contexto debe estar entre 2.048 y 131.072 tokens.');
      const config = { ...(await this.config(profile)), ...patch };
      if (config.directory) {
        config.directory = await fs.realpath(config.directory);
        if (!(await fs.stat(config.directory)).isDirectory())
          throw new Error('Selecciona una carpeta.');
        // Existing libraries may be read-only; only import/download need write access.
        await fs.access(config.directory, fs.constants.R_OK);
      }
      if (config.defaultModel) {
        const exists =
          config.directory &&
          (await (async () => {
            if (/^mmproj/i.test(path.basename(config.defaultModel!))) return false;
            for (const part of modelParts(localModelName(config.defaultModel!))) {
              const { canonical } = await resolveModel(config.directory!, part);
              await checkGGUF(canonical);
            }
            return true;
          })().catch(() => false));
        if (!exists) {
          if (patch.defaultModel)
            throw new Error('El modelo predeterminado no está en la carpeta.');
          config.defaultModel = undefined;
        }
      }
      await this.stopEngine();
      await this.saveConfig(profile, config);
      return this.status(profile);
    });
  }
  private async saveConfig(profile: Profile, config: LocalConfig) {
    const file = this.configPath(profile);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file + '.tmp', JSON.stringify(config), { mode: 0o600 });
    await fs.rename(file + '.tmp', file);
  }
  private async findEngine(): Promise<string | undefined> {
    if (this.enginePath) return this.enginePath;
    const walk = async (dir: string, depth: number): Promise<string | undefined> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (e.isFile() && e.name === 'llama-server') return path.join(dir, e.name);
        if (depth && e.isDirectory()) {
          const found = await walk(path.join(dir, e.name), depth - 1);
          if (found) return found;
        }
      }
    };
    return (this.enginePath = await walk(this.engineDirectory(), 3));
  }
  async status(profile: Profile): Promise<LocalState> {
    const config = await this.config(profile);
    return {
      ...config,
      outputLimit: localOutputLimit(config.context),
      runningContext: this.loaded ? this.loadedContext : undefined,
      engine: !!(await this.findEngine()),
      running: this.loaded ? this.loadedName : undefined,
      ...this.progress,
    };
  }
  private operation<T>(label: string, work: (signal: AbortSignal) => Promise<T>) {
    if (this.closing || this.job || this.active || this.startup)
      throw new Error('Ya hay una operación local en curso.');
    this.progress = { busy: label, downloaded: 0 };
    this.controller = new AbortController();
    const job = work(this.controller.signal).finally(() => {
      this.job = undefined;
      this.controller = undefined;
      this.progress.busy = undefined;
    });
    this.job = job;
    return job;
  }
  private async download(url: string, target: string, signal: AbortSignal) {
    const response = await (this.services.downloadFetch ?? this.services.fetch ?? fetch)(url, {
      signal,
      redirect: 'follow',
    });
    if (!response.ok || !response.body)
      throw new Error(`No se pudo descargar el archivo (${response.status}).`);
    this.progress.total = Number(response.headers.get('content-length')) || undefined;
    const hash = createHash('sha256');
    const stream = Readable.fromWeb(response.body as any);
    stream.on('data', (chunk: Buffer) => {
      this.progress.downloaded += chunk.length;
      hash.update(chunk);
    });
    await pipeline(stream, createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal });
    return hash.digest('hex');
  }
  install() {
    return this.operation('Descargando motor llama.cpp', async (signal) => {
      if (process.platform !== 'darwin' || process.arch !== 'arm64')
        throw new Error(
          'La descarga automática del motor está disponible para macOS Apple Silicon.',
        );
      const parent = path.dirname(this.engineDirectory());
      await fs.mkdir(parent, { recursive: true });
      const temp = await fs.mkdtemp(path.join(parent, '.install-'));
      try {
        const archive = path.join(temp, 'engine.tar.gz');
        const sum = await this.download(
          `https://github.com/ggml-org/llama.cpp/releases/download/${version}/llama-${version}-bin-macos-arm64.tar.gz`,
          archive,
          signal,
        );
        if (sum !== digest) throw new Error('La verificación SHA-256 del motor ha fallado.');
        const unpack = path.join(temp, 'unpacked');
        await fs.mkdir(unpack);
        await new Promise<void>((resolve, reject) => {
          const child = spawn('/usr/bin/tar', ['-xzf', archive, '-C', unpack], {
            signal,
            stdio: 'ignore',
          });
          child.once('error', reject);
          child.once('exit', (code) =>
            code === 0 ? resolve() : reject(new Error('No se pudo extraer el motor.')),
          );
        });
        await this.stopEngine();
        await fs.rm(this.engineDirectory(), { recursive: true, force: true });
        await fs.rename(unpack, this.engineDirectory());
        this.enginePath = undefined;
        const binary = await this.findEngine();
        if (!binary) throw new Error('No se encontró llama-server en la descarga.');
        await fs.chmod(binary, 0o755);
      } finally {
        await fs.rm(temp, { recursive: true, force: true });
      }
    });
  }
  downloadModel(profile: Profile, value: string) {
    return this.operation('Descargando modelo', async (signal) => {
      const { directory } = await this.config(profile);
      if (!directory) throw new Error('Selecciona primero una carpeta de modelos.');
      const url = new URL(value);
      if (
        url.protocol !== 'https:' ||
        url.hostname !== 'huggingface.co' ||
        url.username ||
        url.password ||
        !url.pathname.includes('/resolve/')
      )
        throw new Error(
          'Introduce un enlace HTTPS directo de Hugging Face (/resolve/…) a un archivo GGUF.',
        );
      const name = localModelName(decodeURIComponent(url.pathname.split('/').pop() ?? ''));
      if (name.includes('/')) throw new Error('El nombre del archivo GGUF no es válido.');
      const temp = path.join(directory, `.${name}.${randomBytes(6).toString('hex')}.part`);
      try {
        await this.download(url.href, temp, signal);
        const handle = await fs.open(temp, 'r');
        try {
          const magic = Buffer.alloc(4);
          await handle.read(magic, 0, 4, 0);
          if (magic.toString() !== 'GGUF') throw new Error('La descarga no es un modelo GGUF.');
        } finally {
          await handle.close();
        }
        await fs.link(temp, path.join(directory, name));
      } finally {
        await fs.rm(temp, { force: true });
      }
    });
  }
  async importModel(profile: Profile, source: string) {
    return this.operation('Importando modelo', async () => {
      const { directory } = await this.config(profile);
      if (!directory) throw new Error('Selecciona primero una carpeta de modelos.');
      const name = localModelName(path.basename(source));
      const sources = modelParts(name).map((part) => path.join(path.dirname(source), part));
      for (const file of sources) await checkGGUF(file);
      // Selecting a file already in a subfolder discovers it in place without duplicating GBs.
      const root = await fs.realpath(directory);
      if (insideDirectory(root, await fs.realpath(source))) return;
      const copied: string[] = [];
      try {
        for (const file of sources) {
          const target = path.join(root, path.basename(file));
          await fs.copyFile(file, target, fs.constants.COPYFILE_EXCL);
          copied.push(target);
        }
      } catch (error) {
        await Promise.all(copied.map((file) => fs.unlink(file)));
        throw error;
      }
    });
  }
  removeModel(profile: Profile, name: string, trash: (file: string) => Promise<void>) {
    return this.operation('Moviendo modelo a la papelera', async () => {
      const config = await this.config(profile);
      const { directory } = config;
      if (!directory) throw new Error('Selecciona una carpeta de modelos.');
      const files = await Promise.all(
        modelParts(localModelName(name)).map((part) => resolveModel(directory, part)),
      );
      if (files.some(({ canonical }) => canonical === this.loaded)) await this.stopEngine();
      // Trash a library link itself, not a shared cache blob it points to.
      for (const { file } of files) await trash(file);
      if (config.defaultModel === name)
        await this.saveConfig(profile, { ...config, defaultModel: undefined });
    });
  }
  override async key(profile: Profile) {
    return (await this.catalog(profile)).length ? profile : undefined;
  }
  override async catalog(profile: Profile, signal?: AbortSignal): Promise<ModelInfo[]> {
    signal?.throwIfAborted();
    const config = await this.config(profile);
    if (!config.directory) return [];
    const root = await fs.realpath(config.directory);
    const pending = [''];
    const files = new Set<string>();
    while (pending.length) {
      signal?.throwIfAborted();
      const relative = pending.pop()!;
      const entries = await fs
        .readdir(path.join(root, relative), { withFileTypes: true })
        .catch((error: NodeJS.ErrnoException) => {
          // A missing/unreadable subfolder must not hide the rest of the library.
          if (relative && ['ENOENT', 'EACCES', 'EPERM'].includes(error.code ?? '')) return [];
          throw error;
        });
      for (const entry of entries) {
        signal?.throwIfAborted();
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (entry.name !== '.git' && entry.name !== 'node_modules') pending.push(name);
        } else if (
          (entry.isFile() || entry.isSymbolicLink()) &&
          /\.gguf$/i.test(entry.name) &&
          !/^mmproj/i.test(entry.name)
        ) {
          try {
            const { canonical } = await resolveModel(root, name);
            await checkGGUF(canonical);
            files.add(name);
          } catch {
            // Ignore partial downloads, broken links and paths escaping the chosen library.
          }
        }
      }
    }
    signal?.throwIfAborted();
    return [...files]
      .filter((name) => {
        const split = splitModel(name);
        return (
          !split ||
          (split.part === 1 && split.total > 0 && modelParts(name).every((part) => files.has(part)))
        );
      })
      .sort(
        (a, b) =>
          Number(b === config.defaultModel) - Number(a === config.defaultModel) ||
          a.localeCompare(b),
      )
      .map((name) => ({
        value: name,
        displayName: name.replace(/\.gguf$/i, ''),
        isDefault: name === config.defaultModel,
        description: 'Modelo local · GGUF · texto',
        tools: config.tools,
        image: false,
        contextLength: config.context,
        categories: ['local'],
      }));
  }
  override async usage(profile: Profile) {
    return (await this.key(profile)) ? { checkedAt: Date.now() } : undefined;
  }
  override async disconnect(_profile: Profile) {
    await this.stopEngine();
  }
  cancelDownload() {
    this.controller?.abort();
  }
  async stopEngine() {
    if (this.active || this.startup)
      throw new Error('Espera o detén la respuesta local antes de descargar el modelo de memoria.');
    await this.terminate();
  }
  private async terminate() {
    clearTimeout(this.idle);
    clearInterval(this.monitor);
    this.monitor = undefined;
    const child = this.child;
    this.child = undefined;
    this.loaded = undefined;
    this.loadedName = undefined;
    this.port = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
  private async ensure(profile: Profile, model: string, signal?: AbortSignal) {
    const config = await this.config(profile),
      binary = await this.findEngine();
    if (!binary) throw new Error('Descarga el motor local en Ajustes → Cuentas → Local.');
    if (!config.directory) throw new Error('Selecciona una carpeta de modelos.');
    const { file, canonical } = await resolveModel(config.directory, model);
    for (const part of modelParts(model)) {
      const resolved = await resolveModel(config.directory, part);
      await checkGGUF(resolved.canonical);
    }
    if (
      this.child &&
      this.loaded === canonical &&
      this.loadedName === model &&
      this.loadedContext === config.context &&
      this.loadedCache === config.cacheType &&
      this.port
    )
      return;
    // Caller holds the exclusive generation slot; stop the previous idle model.
    await this.terminate();
    this.memoryError = undefined;
    if ((await this.pressure()) >= 4)
      throw new Error(
        'El Mac tiene presión de memoria. Cierra otras aplicaciones o reduce el contexto antes de cargar el modelo.',
      );
    this.port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const p = (server.address() as net.AddressInfo).port;
        server.close(() => resolve(p));
      });
    });
    const child = spawn(
      binary,
      [
        '-m',
        file,
        '--host',
        '127.0.0.1',
        '--port',
        String(this.port),
        '--ctx-size',
        String(config.context),
        '--parallel',
        '1',
        '--flash-attn',
        'on',
        '--cache-type-k',
        config.cacheType ?? 'q8_0',
        '--cache-type-v',
        config.cacheType ?? 'q8_0',
        '--batch-size',
        '512',
        '--ubatch-size',
        '64',
        '--cache-ram',
        '0',
        '--ctx-checkpoints',
        '1',
        '-ngl',
        '99',
        '--jinja',
        '--no-webui',
        '--alias',
        model,
        '--api-key',
        this.token,
      ],
      {
        cwd: path.dirname(binary),
        env: { ...cleanEnv(), LLAMA_CACHE: path.join(this.engineDirectory(), 'cache') },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    this.child = child;
    let sampling = false;
    const memoryGuard = new LocalMemoryGuard();
    this.monitor = setInterval(() => {
      if (sampling || this.child !== child) return;
      sampling = true;
      void this.pressure()
        .then(async (level) => {
          const swapUsed = level >= 2 && level < 4 ? await this.swap() : undefined;
          const reason = memoryGuard.check(level, Date.now(), swapUsed);
          if (this.child === child && reason) {
            this.memoryError = new Error(
              reason === 'critical'
                ? 'Se ha detenido el modelo por presión de memoria crítica del Mac. Reduce el contexto o usa un modelo más pequeño.'
                : swapUsed !== undefined
                  ? 'Se ha detenido el modelo por presión de memoria y aumento rápido del swap del Mac. Reduce el contexto o usa un modelo más pequeño.'
                  : 'Se ha detenido el modelo por presión de memoria sostenida sin poder comprobar el swap. Reduce el contexto o usa un modelo más pequeño.',
            );
            void this.terminate().catch(() => {});
          }
        })
        .catch(() => {})
        .finally(() => {
          sampling = false;
        });
    }, 1000);
    this.monitor.unref();
    let failure = '',
      spawnError: Error | undefined;
    child.stdout?.on('data', (data: Buffer) => {
      this.diagnostic = (this.diagnostic + data.toString()).slice(-50000);
    });
    child.stderr?.on('data', (data: Buffer) => {
      failure = (failure + data.toString()).slice(-3000);
      this.diagnostic = (this.diagnostic + data.toString()).slice(-50000);
    });
    child.on('error', (e) => {
      spawnError = e;
    });
    child.on('close', () => {
      if (this.child === child) {
        clearInterval(this.monitor);
        this.monitor = undefined;
        this.child = undefined;
        this.loaded = undefined;
        this.port = undefined;
      }
    });
    try {
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        if (this.memoryError) throw this.memoryError;
        if (spawnError || child.exitCode !== null || child.signalCode !== null)
          throw new Error(
            `No se pudo cargar el modelo local. ${spawnError?.message ?? failure.slice(-1200)}`,
          );
        if (
          await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(1000) })
            .then((r) => r.ok)
            .catch(() => false)
        ) {
          this.loaded = canonical;
          this.loadedName = model;
          this.loadedContext = config.context;
          this.loadedCache = config.cacheType;
          return;
        }
        await delay(200);
      }
      throw new Error('El modelo no ha arrancado en tres minutos. Prueba uno más pequeño.');
    } catch (error) {
      await this.terminate();
      throw error;
    }
  }
  override async request(route: string, key: string | undefined, init: RequestInit = {}) {
    if (route !== '/chat/completions' || !key?.startsWith('local-'))
      throw new Error('Solicitud local no válida.');
    if (this.closing || this.active || this.startup || this.job)
      throw new Error('El motor local está ocupado. Espera a que termine el otro chat.');
    this.active = true;
    clearTimeout(this.idle);
    const release = () => {
      this.active = false;
      this.idle = setTimeout(() => {
        void this.stopEngine().catch(() => {});
      }, 5 * 60_000);
      this.idle.unref();
    };
    try {
      const payload = JSON.parse(String(init.body));
      this.startup = this.ensure(key as Profile, payload.model, init.signal ?? undefined);
      try {
        await this.startup;
      } finally {
        this.startup = undefined;
      }
      const response = await fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
        ...init,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({
          ...payload,
          max_tokens: localOutputLimit((await this.config(key as Profile)).context),
          stream_options: { include_usage: true },
          chat_template_kwargs: { enable_thinking: false },
        }),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(
          response.status === 400
            ? 'El modelo rechazó el contexto o las herramientas. Reduce el historial o desactiva herramientas en los ajustes locales.'
            : `Error del motor local (${response.status}).`,
        );
      }
      const reader = response.body.getReader();
      const engineFailure = () => this.memoryError;
      let released = false;
      const done = () => {
        if (!released) {
          released = true;
          release();
        }
      };
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const result = await reader.read();
            if (result.done) {
              done();
              if (engineFailure()) controller.error(engineFailure());
              else controller.close();
            } else controller.enqueue(result.value);
          } catch (e) {
            done();
            controller.error(engineFailure() ?? e);
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            done();
          }
        },
      });
      return new Response(body, { status: response.status, headers: response.headers });
    } catch (e) {
      release();
      throw this.memoryError ?? e;
    }
  }
  async shutdown() {
    this.closing = true;
    this.cancelDownload();
    await this.job?.catch(() => {});
    await this.startup?.catch(() => {});
    this.active = false;
    await this.stopEngine();
  }
}
