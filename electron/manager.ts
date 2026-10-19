import { readGit, changeGit, repositoryRoot } from './git';
import {
  commitWorktree,
  createWorktree,
  mergeWorktree,
  removeWorktree,
  updateWorktree,
  worktreeSettings,
  worktreeStatus,
} from './worktrees';
import { canIsolate, isolationLocked, wantsWorktree } from '../src/isolation';
import type { GitOperation } from '../src/git-types';
import { codexAttachmentContent, type PreparedAttachment } from './attachments';
import { codexUsage, claudeUsage } from '../src/subscription-usage';
import {
  providerKind,
  providerNames,
  isConnectedProvider,
  type ProviderKind,
  type ModelSelection,
  type ProviderConfig,
  isCodex,
  defaultOptimization,
  type TokenOptimization,
} from '../src/shared';
import { sessionAccountLocked } from '../src/session-tabs';
import { savingInstructions, turnOptimization } from './token-optimization';
import { fetchCodexModels, selectCodexConfig, resolveCodexModel } from './codex-models';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as pty from './pty';
import type {
  ClaudeConfig,
  CodexConfig,
  DeskEvent,
  Message,
  Profile,
  Session,
} from '../src/shared';
import { efforts, permissionModes, type ProfileDefinition } from '../src/shared';
import { Store } from './store';
import {
  Coordinator,
  coordinationInstructions,
  isCoordinationApproval,
  isolatedInstructions,
} from './coordination';
import { ProjectTerminals } from './project-terminals';
import { Rpc } from './rpc';
import { Accounts } from './accounts';
import { stopAccountSessions } from './account-guard';
import { ClaudeRuntime } from './claude';
import { note, settle } from './claude-events';
import { applyCodexEvent, messageFromItem } from './codex-events';
import { reapGroup } from './processes';
import {
  active,
  approvalResult,
  claudeArgs,
  claudeOptions,
  cleanEnv,
  codexParams,
  mergeCodexConfig,
  mergeConfig,
  profileDirectory,
} from './core';
import type { ProviderServices } from './openrouter';
import type { ProviderRuntime } from './provider-runtime';
import { OpenRouterRuntime } from './openrouter-runtime';
import { OpenCodeRuntime } from './opencode-runtime';
import { GeminiRuntime, geminiRpc, geminiAccount } from './gemini';
import {
  AntigravityRuntime,
  antigravityEnv,
  isAntigravity,
  linkedAntigravity,
} from './antigravity';
const exec = promisify(execFile);
type Runtime = {
  provider?: ProviderRuntime;
  pendingImages?: import('../src/shared').Attachment[];
  pendingUserText?: string;
  rpc?: Rpc;
  pty?: pty.IPty;
  claude?: ClaudeRuntime;
  loginOnly?: boolean;
  buffer: string;
  sequence: number;
  loginId?: string;
  loaded?: boolean;
  optimizedControls?: boolean;
  optimizationLevel?: TokenOptimization['level'];
  exit?: Promise<void>;
};
/** Configuration keys the SDK can change while the agent runs. The rest need a restart. */
const liveKeys: (keyof ClaudeConfig)[] = [
  'model',
  'permissionMode',
  'allowBypass', // Legacy UI capability flag; interactive runtimes now support mode changes at startup.
  'effort',
  'thinking',
  'thinkingBudget',
  'thinkingDisplay',
];
export class Manager {
  readonly accounts: Accounts;
  readonly terminals: ProjectTerminals;
  readonly buffers = new Map<string, { data: string; sequence: number }>();
  readonly store: Store;
  readonly runtimes = new Map<string, Runtime>();
  readonly coordinator = new Coordinator(() => this.changed());
  private operations = new Set<string>();
  private operationWork = new Map<string, Promise<unknown>>();
  private stoppingRuntimes = new Map<string, Promise<void>>();
  private removingProjects = new Map<string, Promise<void>>();
  private modelJobs = new Map<string, { controller: AbortController; work: Promise<void> }>();
  private gitJobs = new Set<string>();
  private gitWork = new Set<Promise<unknown>>();
  private eventTimer?: NodeJS.Timeout;
  /** `profilesRoot` lets tests reuse authenticated profiles with an isolated state file. */
  constructor(
    root: string,
    private emit: (e: DeskEvent) => void,
    readonly profilesRoot = root,
    private networkEnvironment: () => Record<string, string> = () => ({}),
    services: ProviderServices = {},
  ) {
    this.store = new Store(root);
    this.terminals = new ProjectTerminals(this.emit, () => this.changed());
    this.accounts = new Accounts(
      this.profilesRoot,
      () => this.state.tools,
      () => this.changed(),
      this.emit,
      async (profile, confirmed) => {
        const sessions = await stopAccountSessions(
          profile,
          confirmed,
          this.state.sessions,
          this.operations,
          this.runtimes,
          (id) => this.stop(id),
        );
        for (const s of sessions) {
          s.account = undefined;
          s.loginPending = false;
          s.info = undefined;
          s.rateLimit = undefined;
        }
        this.changed();
      },
      this.networkEnvironment,
      services,
      (profile) => this.state.profiles?.find((p) => p.id === profile)?.googleCloudProject,
    );
    for (const p of this.state.profiles ?? []) this.accounts.register(p.id);
  }
  get state() {
    return this.store.state;
  }
  addAccount(kind: ProviderKind, name?: string) {
    const definitions = (this.state.profiles ??= []);
    if (definitions.length >= 100) throw new Error('Has alcanzado el límite de 100 perfiles.');
    let index = 1;
    const idAt = (index: number): Profile =>
      kind === 'codex' && index === 1 ? 'codex' : `${kind}-${index}`;
    while (
      index <= 9999 &&
      (definitions.some((p) => p.id === idAt(index)) ||
        this.state.removedProfiles?.includes(idAt(index)) ||
        fs.existsSync(profileDirectory(this.profilesRoot, idAt(index))))
    )
      index++;
    if (index > 9999) throw new Error('No quedan identificadores disponibles para este proveedor.');
    const definition: ProfileDefinition = {
      id: idAt(index),
      name: name?.trim() || `${providerNames[kind]} ${index}`,
      kind,
      ...(kind === 'opencode' ? { modelSelection: { freeOnly: true, models: [] } } : {}),
    };
    definitions.push(definition);
    this.state.defaultProfile ??= definition.id;
    this.accounts.register(definition.id);
    if (this.state.selectedProject && !this.state.selectedSession)
      this.select(this.state.selectedProject, undefined, definition.id);
    this.store.flush();
    this.changed();
    return definition;
  }
  get canRestart() {
    return (
      this.runtimes.size === 0 &&
      this.operations.size === 0 &&
      !this.accounts.active &&
      this.gitJobs.size === 0
    );
  }
  private changingFreebuff = false;
  async setFreebuffEnabled(enabled: boolean) {
    if (this.changingFreebuff) throw new Error('Espera a que termine el cambio de Freebuff.');
    this.changingFreebuff = true;
    const before = this.state.freebuffEnabled;
    this.state.freebuffEnabled = enabled;
    try {
      if (!enabled) {
        const terminals = this.terminals.snapshot().filter((t) => t.kind === 'freebuff');
        await Promise.all(terminals.map((t) => this.terminals.stopFreebuff(t.projectId)));
        for (const terminal of terminals) this.terminals.buffers.delete(terminal.id);
      }
      this.store.flush();
      this.changed();
      return true;
    } catch (error) {
      this.state.freebuffEnabled = before;
      this.changed();
      throw error;
    } finally {
      this.changingFreebuff = false;
    }
  }
  setAccountColor(profile: Profile, color: string | null) {
    const definition = this.state.profiles?.find((p) => p.id === profile);
    if (!definition || this.accounts.removing(profile))
      throw new Error('Esta cuenta no está disponible.');
    if (color !== null && !/^#[0-9a-f]{6}$/i.test(color))
      throw new Error('Color de cuenta no válido.');
    if (color === null) delete definition.color;
    else definition.color = color.toLowerCase();
    this.store.flush();
    this.changed();
    return true;
  }
  setDefaultAccount(profile: Profile) {
    if (!this.state.profiles?.some((p) => p.id === profile) || this.accounts.removing(profile))
      throw new Error('Esta cuenta no está disponible.');
    this.state.defaultProfile = profile;
    this.store.flush();
    this.changed();
    return true;
  }
  async changeSessionAccount(id: string, profile: Profile) {
    return this.exclusive(id, async () => {
      const session = this.session(id);
      if (sessionAccountLocked(session))
        throw new Error('Este chat ya ha comenzado. Abre otra pestaña para cambiar de cuenta.');
      if (!this.state.profiles?.some((p) => p.id === profile) || this.accounts.removing(profile))
        throw new Error('Esta cuenta no está disponible.');
      if (session.profile === profile) return session;
      this.modelJobs.get(id)?.controller.abort();
      await this.modelJobs.get(id)?.work;
      await this.stopRuntime(id);
      if (sessionAccountLocked(session))
        throw new Error('Este chat ya ha comenzado. Abre otra pestaña para cambiar de cuenta.');
      const previous = [...this.state.sessions]
        .reverse()
        .find((s) => s.projectId === session.projectId && s.profile === profile);
      const sameProvider = providerKind(profile) === providerKind(session.profile);
      const next: Session = {
        id,
        projectId: session.projectId,
        title: session.title,
        profile,
        accountLocked: false,
        status: 'stopped',
        messages: [],
        approvals: [],
        providerConfig: isConnectedProvider(profile)
          ? ((sameProvider ? session : previous)?.providerConfig ?? { model: 'default' })
          : undefined,
        reference: isCodex(profile) || isConnectedProvider(profile) ? undefined : randomUUID(),
        mode: isCodex(profile) ? undefined : 'chat',
        config:
          isCodex(profile) || isConnectedProvider(profile)
            ? undefined
            : mergeConfig((sameProvider ? session : previous)?.config),
        codexConfig: isCodex(profile)
          ? mergeCodexConfig((sameProvider ? session : previous)?.codexConfig)
          : undefined,
      };
      this.state.sessions[this.state.sessions.indexOf(session)] = next;
      this.store.flush();
      this.changed();
      return next;
    });
  }
  async removeAccount(
    profile: Profile,
    confirmed: boolean,
    trash: (directory: string) => Promise<void>,
  ) {
    return this.accounts.remove(profile, confirmed, async () => {
      const jobs = this.state.sessions
        .filter((s) => s.profile === profile)
        .map((s) => this.modelJobs.get(s.id))
        .filter((job) => !!job);
      for (const job of jobs) job.controller.abort();
      await Promise.allSettled(jobs.map((job) => job.work));
      const definition = this.state.profiles?.find((p) => p.id === profile);
      if (!definition) throw new Error('Esta cuenta no existe. Añádela en Ajustes.');
      const sessions = this.state.sessions.filter((s) => s.profile === profile);
      const directory = profileDirectory(this.profilesRoot, profile);
      // Keep a recoverable copy of conversations alongside the provider's local data.
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(directory, 'agent-desk-removed-account.json'),
        JSON.stringify({
          profile: definition,
          sessions,
        }),
        { mode: 0o600 },
      );
      await trash(directory);
      const before = this.store.state;
      const remaining = before.sessions.filter((s) => s.profile !== profile);
      this.store.state = {
        ...before,
        profiles: before.profiles?.filter((p) => p.id !== profile),
        defaultProfile:
          before.defaultProfile === profile
            ? before.profiles?.find((p) => p.id !== profile)?.id
            : before.defaultProfile,
        removedProfiles: [...(before.removedProfiles ?? []), profile],
        sessions: remaining,
        selectedSession: remaining.some((s) => s.id === before.selectedSession)
          ? before.selectedSession
          : remaining.find((s) => s.projectId === before.selectedProject)?.id,
      };
      try {
        this.store.flush();
      } catch (error) {
        this.store.state = before;
        throw error;
      }
      for (const session of sessions) this.buffers.delete(session.id);
    });
  }
  changed() {
    this.store.schedule();
    if (!this.eventTimer)
      this.eventTimer = setTimeout(() => {
        this.eventTimer = undefined;
        this.emit({ type: 'state', state: this.state });
      }, 30);
  }
  session(id: string) {
    const s = this.state.sessions.find((s) => s.id === id);
    if (!s) throw new Error('Sesión desconocida.');
    return s;
  }
  project(id: string) {
    if (this.removingProjects.has(id)) throw new Error('Se está quitando este proyecto.');
    const p = this.state.projects.find((p) => p.id === id);
    if (!p) throw new Error('Proyecto desconocido.');
    return p;
  }
  async discover() {
    for (const name of ['claude', 'codex', 'gemini', 'freebuff'] as const) {
      if (name === 'gemini') {
        const directory = path.join(this.profilesRoot, 'tools/antigravity');
        if (fs.existsSync(directory)) {
          const installed = fs
            .readdirSync(directory)
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
            .map((v) => path.join(directory, v, 'agy'))
            .find((p) => fs.existsSync(p));
          if (installed) {
            this.state.tools.gemini = installed;
            continue;
          }
        }
      }
      if (this.state.tools[name] && fs.existsSync(this.state.tools[name]!)) continue;
      const home = cleanEnv().HOME ?? '';
      const paths = [
        ...(name === 'freebuff'
          ? [path.join(this.profilesRoot, 'tools/freebuff/node_modules/.bin/freebuff')]
          : []),
        path.resolve('node_modules/.bin', name),
        ...cleanEnv()
          .PATH.split(':')
          .map((p) => path.join(p, name)),
        /* Codex ships inside the ChatGPT app on macOS. */
        ...(name === 'codex'
          ? ['/Applications', path.join(home, 'Applications'), path.join(home, 'Aplicaciones')].map(
              (dir) =>
                path.join(
                  dir,
                  'ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
                ),
            )
          : []),
      ];
      this.state.tools[name] = paths.find((p) => {
        try {
          fs.accessSync(p, fs.constants.X_OK);
          return true;
        } catch {
          return false;
        }
      });
    }
    this.changed();
  }
  moveProject(projectId: string, targetProjectId: string) {
    const projects = this.state.projects;
    const from = projects.findIndex((p) => p.id === projectId);
    const to = projects.findIndex((p) => p.id === targetProjectId);
    if (from < 0 || to < 0) throw new Error('Este proyecto ya no está disponible.');
    if (from === to) return true;
    const next = [...projects];
    const [project] = next.splice(from, 1);
    next.splice(to, 0, project);
    this.state.projects = next;
    this.store.flush();
    this.changed();
    return true;
  }
  async addProject(folder: string) {
    const canonical = await fs.promises.realpath(folder);
    if (!(await fs.promises.stat(canonical)).isDirectory())
      throw new Error('Selecciona una carpeta.');
    let project = this.state.projects.find((p) => p.path === canonical);
    if (!project) {
      project = { id: randomUUID(), name: path.basename(canonical), path: canonical };
      this.state.projects.push(project);
    }
    this.select(project.id);
    return project;
  }
  select(projectId: string, sessionId?: string, profile?: Profile) {
    this.project(projectId);
    let s = sessionId
      ? this.session(sessionId)
      : [...this.state.sessions]
          .reverse()
          .find((s) => s.projectId === projectId && (!profile || s.profile === profile));
    if (s && s.projectId !== projectId) throw new Error('La sesión pertenece a otro proyecto.');
    const selectedProfile = profile ?? this.state.defaultProfile ?? this.state.profiles?.[0]?.id;
    if (!s && selectedProfile) s = this.newSession(projectId, selectedProfile);
    this.state.selectedProject = projectId;
    this.state.selectedSession = s?.id;
    this.changed();
    return s;
  }
  newSession(
    projectId: string,
    profile = this.state.defaultProfile ?? this.state.profiles?.[0]?.id,
    mode?: 'chat' | 'terminal',
  ) {
    this.project(projectId);
    if (!profile) throw new Error('Añade una cuenta en Ajustes antes de abrir un chat.');
    if (!(this.state.profiles ?? []).some((p) => p.id === profile))
      throw new Error('Esta cuenta no existe. Añádela en Ajustes.');
    if (this.accounts.removing(profile)) throw new Error('Se está eliminando esta cuenta.');
    const count = this.state.sessions.filter((s) => s.projectId === projectId).length + 1;
    const previous = [...this.state.sessions]
      .reverse()
      .find((s) => s.projectId === projectId && s.profile === profile);
    const s: Session = {
      id: randomUUID(),
      projectId,
      profile,
      accountLocked: false,
      title: `Sesión ${count}`,
      providerConfig: isConnectedProvider(profile)
        ? (previous?.providerConfig ?? { model: 'default' })
        : undefined,
      reference: isCodex(profile) || isConnectedProvider(profile) ? undefined : randomUUID(),
      mode: isCodex(profile) ? undefined : isConnectedProvider(profile) ? 'chat' : (mode ?? 'chat'),
      config:
        isCodex(profile) || isConnectedProvider(profile)
          ? undefined
          : mergeConfig(previous?.config),
      codexConfig: isCodex(profile) ? mergeCodexConfig(previous?.codexConfig) : undefined,
      status: 'stopped',
      messages: [],
      approvals: [],
    };
    this.state.sessions.push(s);
    const models = [...this.state.sessions]
      .reverse()
      .find((other) => other.profile === profile && other.info?.models.length)?.info?.models;
    if (models)
      s.info = {
        tools: [],
        commands: [],
        models: structuredClone(models),
        mcpServers: [],
        skills: [],
        plugins: [],
        agents: [],
        outputStyles: [],
      };
    this.state.selectedProject = projectId;
    this.state.selectedSession = s.id;
    this.changed();
    return s;
  }
  renameProject(id: string, name: string) {
    this.project(id).name = name;
    this.changed();
  }
  rename(id: string, title: string) {
    this.session(id).title = title;
    this.changed();
  }
  setMode(id: string, mode: 'chat' | 'terminal') {
    const s = this.session(id);
    if (
      providerKind(s.profile) !== 'claude' &&
      !(providerKind(s.profile) === 'gemini' && isAntigravity(this.state.tools.gemini))
    )
      throw new Error('Este proveedor solo tiene chat.');
    if (active(s)) throw new Error('Detén la sesión antes de cambiar entre chat y terminal.');
    s.mode = mode;
    this.changed();
    return true;
  }
  removeProject(id: string, cleanup: (sessions: Session[]) => Promise<void> = async () => {}) {
    const pending = this.removingProjects.get(id);
    if (pending) return pending;
    this.project(id);
    const sessions = this.state.sessions.filter((s) => s.projectId === id);
    const work = Promise.resolve()
      .then(async () => {
        for (const s of sessions) this.modelJobs.get(s.id)?.controller.abort();
        const earlyStops = sessions
          .filter((s) => this.runtimes.has(s.id))
          .map((s) => this.stopRuntime(s.id));
        await Promise.allSettled([
          ...earlyStops,
          ...this.gitWork,
          ...sessions.flatMap((s) => [
            this.operationWork.get(s.id),
            this.modelJobs.get(s.id)?.work,
          ]),
        ]);
        const stops = await Promise.allSettled([
          this.terminals.stop(id),
          ...sessions.map((s) => this.stopRuntime(s.id)),
        ]);
        const failed = stops.find((r) => r.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        if (sessions.some((s) => this.runtimes.has(s.id)))
          throw new Error(
            'No se ha confirmado el cierre de todos los agentes. Vuelve a quitar el proyecto.',
          );
        await cleanup(sessions);
        for (const s of sessions) {
          this.buffers.delete(s.id);
          this.coordinator.unregister(s.id);
        }
        this.terminals.buffers.delete(`shell:${id}`);
        this.terminals.buffers.delete(`freebuff:${id}`);
        this.state.projects = this.state.projects.filter((p) => p.id !== id);
        this.state.sessions = this.state.sessions.filter((s) => s.projectId !== id);
        if (this.state.selectedProject === id) {
          this.state.selectedProject = undefined;
          this.state.selectedSession = undefined;
          if (this.state.projects[0]) this.select(this.state.projects[0].id);
        }
        this.store.flush();
        this.changed();
      })
      .finally(() => this.removingProjects.delete(id));
    this.removingProjects.set(id, work);
    return work;
  }
  async exclusive<T>(id: string, fn: () => Promise<T>) {
    const session = this.state.sessions.find((s) => s.id === id);
    if (session && this.removingProjects.has(session.projectId))
      throw new Error('Se está quitando este proyecto.');
    if (this.operations.has(id)) throw new Error('Hay una operación pendiente en esta sesión.');
    this.operations.add(id);
    const work = Promise.resolve().then(fn);
    this.operationWork.set(id, work);
    try {
      return await work;
    } finally {
      this.operations.delete(id);
      this.operationWork.delete(id);
    }
  }
  async continueAntigravity(id: string) {
    return this.exclusive(id, async () => {
      const s = this.session(id);
      if (
        providerKind(s.profile) !== 'gemini' ||
        !isAntigravity(this.state.tools.gemini) ||
        !s.reference?.startsWith('agy:')
      )
        throw new Error('Este chat no tiene una conversación de Antigravity para continuar.');
      if (s.mode === 'terminal' && this.runtimes.get(id)?.pty) return true;
      if (['working', 'waiting', 'starting', 'stopping'].includes(s.status))
        throw new Error('Espera a que termine el turno antes de revisar los permisos.');
      const previousMode = s.mode;
      await this.stopRuntime(id);
      s.mode = 'terminal';
      try {
        await this.startRuntime(id, false, true);
        s.messages.push({
          id: 'agy-handoff:' + randomUUID(),
          role: 'system',
          kind: 'info',
          text: 'La tarea continúa en el panel de Gemini. Revisa allí las solicitudes de permiso.',
          at: Date.now(),
        });
        this.changed();
        return true;
      } catch (error) {
        s.mode = previousMode;
        this.changed();
        throw error;
      }
    });
  }
  async start(id: string, loginOnly = false) {
    return this.exclusive(id, () => this.startRuntime(id, loginOnly));
  }
  private async startRuntime(id: string, loginOnly = false, continueTask = false) {
    this.modelJobs.get(id)?.controller.abort();
    await this.modelJobs.get(id)?.work;
    const s = this.session(id),
      project = this.project(s.projectId);
    if ([...this.gitJobs].some((root) => this.insideRepository(root, project.path)))
      throw new Error('Espera a que termine la operación de Git antes de abrir el agente.');
    if (
      this.accounts.changing(s.profile) &&
      (this.accounts.removing(s.profile) || this.accounts.state[s.profile].busy !== 'checking')
    )
      throw new Error('Completa la operación de esta cuenta en Ajustes antes de abrir el agente.');
    if (this.runtimes.has(id)) return;
    if (isConnectedProvider(s.profile)) {
      if ((await fs.promises.realpath(project.path)) !== project.path)
        throw new Error('La carpeta ha cambiado de ubicación.');
      const rt: Runtime = { buffer: '', sequence: 0 };
      this.runtimes.set(id, rt);
      s.status = 'starting';
      s.error = undefined;
      this.changed();
      try {
        if (['openrouter', 'opencode'].includes(providerKind(s.profile))) {
          if (!(await this.accounts.api(s.profile).key(s.profile)))
            throw new Error('Conecta la cuenta API en Ajustes.');
          await this.refreshModels(id);
          if (!s.info?.models.length)
            throw new Error(s.modelsError ?? 'Selecciona modelos en Ajustes.');
          if (providerKind(s.profile) === 'opencode') {
            const runtime = new OpenCodeRuntime(
              s,
              project.path,
              this.profilesRoot,
              this.accounts.opencode,
              () => this.changed(),
              () => this.selectedModels(s.profile),
              this.networkEnvironment,
            );
            rt.provider = runtime;
            await runtime.start();
          } else {
            rt.provider = new OpenRouterRuntime(
              s,
              project.path,
              this.accounts.api(s.profile),
              () => this.changed(),
              () => this.selectedModels(s.profile),
              () => savingInstructions(this.optimization(s.profile).level),
            );
          }
        } else {
          const binary = this.state.tools.gemini,
            dir = profileDirectory(this.profilesRoot, s.profile);
          if (!binary) throw new Error('No se encontró Gemini CLI.');
          if (isAntigravity(binary)) {
            if ((await linkedAntigravity(this.profilesRoot)) !== s.profile)
              throw new Error('Vincula tu cuenta de Antigravity en Ajustes.');
            if (s.mode === 'terminal') {
              await this.startAntigravityTerminal(s, rt, binary, project.path, continueTask);
              return;
            }
            const runtime = new AntigravityRuntime(
              s,
              binary,
              project.path,
              this.networkEnvironment(),
              () => this.changed(),
            );
            rt.provider = runtime;
            await runtime.start();
            this.changed();
            return;
          }
          if ((await geminiAccount(dir)).status !== 'signedIn')
            throw new Error('Conecta tu cuenta Google en Ajustes.');
          const rpc = await geminiRpc(
            binary,
            dir,
            this.networkEnvironment(),
            project.path,
            this.state.profiles?.find((p) => p.id === s.profile)?.googleCloudProject,
          );
          const gemini = new GeminiRuntime(s, rpc, project.path, () => this.changed());
          rt.provider = gemini;
          await gemini.start();
        }
        s.status = 'ready';
        this.changed();
        return;
      } catch (e) {
        await rt.provider?.stop();
        this.runtimes.delete(id);
        s.status = 'error';
        s.error = (e as Error).message;
        this.changed();
        throw e;
      }
    }
    const binary = this.state.tools[isCodex(s.profile) ? 'codex' : 'claude'];
    if (!binary)
      throw new Error(
        `${isCodex(s.profile) ? 'Codex' : 'Claude Code'} no está instalado. Selecciona su ejecutable en Ajustes.`,
      );
    if ((await fs.promises.realpath(project.path)) !== project.path)
      throw new Error(
        'La carpeta ha cambiado de ubicación. Quita el proyecto y vuelve a añadirlo.',
      );
    const dir = profileDirectory(this.profilesRoot, s.profile);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    this.project(s.projectId); // Removal may have begun while the startup paths were checked.
    let cwd = project.path;
    if (!isCodex(s.profile) && !loginOnly) {
      s.status = 'starting';
      this.changed();
      try {
        cwd = await this.workspace(s, project.path);
        this.project(s.projectId);
      } catch (e) {
        s.status = 'error';
        s.error = (e as Error).message;
        this.changed();
        throw e;
      }
    }
    this.coordinator.register(s, cwd, cwd !== project.path);
    s.status = 'starting';
    s.error = undefined;
    s.approvals = [];
    s.activity = undefined;
    this.changed();
    const rt: Runtime = {
      buffer: this.buffers.get(id)?.data ?? '',
      sequence: this.buffers.get(id)?.sequence ?? 0,
    };
    this.runtimes.set(id, rt);
    try {
      if (isCodex(s.profile)) await this.startCodex(s, rt, binary, dir, project.path);
      else if ((s.mode ?? 'chat') === 'chat' && !loginOnly)
        await this.startClaude(s, rt, binary, dir, cwd, project.path);
      else await this.startTerminal(s, rt, binary, dir, cwd, loginOnly);
    } catch (e) {
      s.error = (e as Error).message;
      if (rt.rpc) {
        try {
          await rt.rpc.stop();
          await rt.exit;
        } catch {
          s.status = 'stopping';
          this.changed();
          throw e;
        }
      }
      if (rt.claude) {
        try {
          await rt.claude.stop();
        } catch {
          /* the exit handler releases the lock when the process is confirmed gone */
        }
      }
      if (!rt.pty && this.runtimes.get(id) === rt) {
        this.runtimes.delete(id);
        this.coordinator.unregister(id);
      }
      // Process cleanup may emit a generic exit reason; keep the startup cause.
      s.error = (e as Error).message;
      s.status = 'error';
      this.changed();
      throw e;
    }
  }
  /**
   * Folder for a Claude chat: its existing worktree, a new one when isolation applies, or the
   * shared project folder. An implicit isolation that cannot be created falls back to sharing.
   */
  private async workspace(s: Session, projectPath: string) {
    if (s.worktree) {
      if (!fs.existsSync(path.join(s.worktree.path, '.git')))
        throw new Error(
          'El worktree de este chat ya no existe. Descártalo desde la barra de Git o abre un chat nuevo.',
        );
      return s.worktree.cwd;
    }
    if (!wantsWorktree(s, this.state.sessions)) return projectPath;
    try {
      const root = await repositoryRoot(projectPath);
      if (root && this.gitJobs.has(root)) throw new Error('Hay una operación de Git en curso.');
      s.worktree = await createWorktree({
        project: projectPath,
        dataDir: this.state.dataDir,
        title: s.title,
        id: s.id,
      });
      this.store.flush(); // Never lose track of a branch the desk created.
      note(
        s,
        'info',
        `Aislado en el worktree ${s.worktree.branch} (desde ${s.worktree.base}). Los cambios no tocan la copia principal hasta que los fusiones.`,
      );
      return s.worktree.cwd;
    } catch (error) {
      if (s.isolation === 'worktree') throw error;
      note(
        s,
        'warning',
        `No se ha podido aislar el chat en un worktree: ${(error as Error).message} Comparte la carpeta con los demás agentes mediante reservas coordinadas.`,
      );
      return projectPath;
    }
  }
  private worktreeOptions(project: string) {
    // Official settings: the agent's own EnterWorktree/subagent isolation behave like ours.
    return { ...worktreeSettings(project), baseRef: 'head' as const };
  }
  private async startClaude(
    s: Session,
    rt: Runtime,
    binary: string,
    dir: string,
    cwd: string,
    projectPath: string,
  ) {
    const options = claudeOptions(s, { cwd, binary, profileDir: dir });
    const isolated = !!s.worktree && cwd === s.worktree.cwd;
    options.env = { ...(options.env as Record<string, string>), ...this.networkEnvironment() };
    options.settings = {
      ...(options.settings as Record<string, unknown>),
      worktree: this.worktreeOptions(projectPath),
    };
    options.mcpServers = {
      agent_desk: { type: 'stdio', ...(await this.coordinator.config(s.id)) },
    };
    if (isolated) {
      // Project settings, hooks, .mcp.json and .claude come from the trusted main checkout.
      options.projectConfigRoot = projectPath;
      options.disallowedTools = [
        ...((options.disallowedTools as string[] | undefined) ?? []),
        'mcp__agent_desk__coordinate',
      ];
    }
    options.systemPrompt = {
      type: 'preset',
      preset: 'claude_code',
      append: [
        s.config?.appendSystemPrompt,
        isolated
          ? isolatedInstructions(s.worktree!.branch, s.worktree!.base)
          : coordinationInstructions,
      ]
        .filter(Boolean)
        .join('\n\n'),
    };
    let previousLevel: number | undefined;
    options.hooks = {
      UserPromptSubmit: [
        {
          hooks: [
            async () => {
              const level = this.optimization(s.profile).level;
              if (
                level === 0 &&
                (previousLevel === 0 ||
                  (previousLevel === undefined && !s.messages.some((m) => m.role === 'user')))
              )
                return {};
              previousLevel = level;
              return {
                hookSpecificOutput: {
                  hookEventName: 'UserPromptSubmit',
                  additionalContext:
                    savingInstructions(level) ||
                    'Preferencia de ahorro desactivada: responde según la petición y los ajustes habituales.',
                },
              };
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: 'Write|Edit|MultiEdit|NotebookEdit',
          hooks: [
            async (input: any) => {
              const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
              if (!file) return {};
              try {
                const result = this.coordinator.call(s.id, { operation: 'claim', paths: [file] });
                if (result.ok) return {};
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'deny',
                    permissionDecisionReason: JSON.stringify(result),
                  },
                };
              } catch (e) {
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'deny',
                    permissionDecisionReason: (e as Error).message,
                  },
                };
              }
            },
          ],
        },
      ],
    };
    // A worktree is real isolation; cooperative reservations only guard a shared folder.
    if (isolated) delete (options.hooks as Record<string, unknown>).PreToolUse;
    const runtime = (rt.claude = new ClaudeRuntime(
      s,
      options,
      () => this.changed(),
      (reason, unexpected) => this.exited(s, reason, undefined, !unexpected),
    ));
    await runtime.start();
    const deadline = Date.now() + 15000;
    let connected = false;
    do {
      const servers = await runtime.mcpStatus();
      const coordinator = servers?.find((server: any) => server.name === 'agent_desk');
      if (coordinator?.status === 'connected') {
        connected = true;
        break;
      }
      if (coordinator?.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    } while (Date.now() < deadline);
    if (!connected)
      throw new Error(
        'Claude no ha podido conectar la coordinación local. No se ha enviado la tarea. Comprueba la versión de Claude Code y vuelve a intentarlo.',
      );
    s.status = 'ready';
    void runtime.refreshContext();
    this.changed();
  }
  private async startTerminal(
    s: Session,
    rt: Runtime,
    binary: string,
    dir: string,
    cwd: string,
    loginOnly: boolean,
  ) {
    const mcpFile = path.join(this.state.dataDir, 'runtime', `${s.id}.mcp.json`);
    const terminalArgs = loginOnly ? ['auth', 'login', '--claudeai'] : claudeArgs(s);
    if (!loginOnly) {
      await fs.promises.mkdir(path.dirname(mcpFile), { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(
        mcpFile,
        JSON.stringify({ mcpServers: { agent_desk: await this.coordinator.config(s.id) } }),
        { mode: 0o600 },
      );
      const isolated = !!s.worktree && cwd === s.worktree.cwd;
      terminalArgs.push(
        '--mcp-config',
        mcpFile,
        '--append-system-prompt',
        isolated
          ? isolatedInstructions(s.worktree!.branch, s.worktree!.base)
          : coordinationInstructions,
      );
      if (isolated) terminalArgs.push('--disallowedTools', 'mcp__agent_desk__coordinate');
    }
    const terminal = (rt.pty = pty.spawn(binary, terminalArgs, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd,
      env: { ...cleanEnv(), ...this.networkEnvironment(), CLAUDE_CONFIG_DIR: dir },
    }));
    rt.loginOnly = loginOnly;
    if (!loginOnly) s.attempted = true;
    rt.exit = new Promise((resolve, reject) =>
      terminal.onExit(({ exitCode }) => {
        void this.exited(
          s,
          loginOnly
            ? exitCode === 0
              ? 'Inicio de sesión completado. Abre el agente para continuar.'
              : `El inicio de sesión terminó (${exitCode}).`
            : `Claude Code terminó (${exitCode}).`,
          terminal.pid,
          loginOnly && exitCode === 0,
        ).then(resolve, reject);
      }),
    );
    rt.exit.catch(() => {});
    terminal.onData((data) => {
      rt.buffer = (rt.buffer + data).slice(-2_000_000);
      rt.sequence++;
      this.buffers.set(s.id, { data: rt.buffer, sequence: rt.sequence });
      this.emit({ type: 'terminal', sessionId: s.id, data, sequence: rt.sequence });
    });
    s.status = 'terminal';
    this.changed();
  }
  private async startAntigravityTerminal(
    s: Session,
    rt: Runtime,
    binary: string,
    cwd: string,
    continueTask = false,
  ) {
    const args: string[] = [];
    if (s.reference?.startsWith('agy:')) args.push('--conversation', s.reference.slice(4));
    else if (s.attempted && s.reference) throw new Error('Crea un chat nuevo para Antigravity.');
    if (s.providerConfig?.model && s.providerConfig.model !== 'default')
      args.push('--model', s.providerConfig.model);
    if (continueTask)
      args.push(
        '--prompt-interactive',
        'Continúa la tarea anterior. Si necesitas permisos, solicítalos para que pueda revisarlos aquí.',
      );
    const terminal = (rt.pty = pty.spawn(binary, args, {
      cwd,
      env: antigravityEnv(this.networkEnvironment()),
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
    }));
    rt.exit = new Promise((resolve, reject) =>
      terminal.onExit(({ exitCode }) => {
        void this.exited(s, `Antigravity terminó (${exitCode}).`, terminal.pid).then(
          resolve,
          reject,
        );
      }),
    );
    rt.exit.catch(() => {});
    terminal.onData((data) => {
      rt.buffer = (rt.buffer + data).slice(-2_000_000);
      rt.sequence++;
      this.buffers.set(s.id, { data: rt.buffer, sequence: rt.sequence });
      this.emit({ type: 'terminal', sessionId: s.id, data, sequence: rt.sequence });
    });
    s.status = 'terminal';
    this.changed();
  }
  private async startCodex(s: Session, rt: Runtime, binary: string, dir: string, cwd: string) {
    const rpc = (rt.rpc = new Rpc(
      binary,
      [
        'app-server',
        '--listen',
        'stdio://',
        '-c',
        'forced_login_method="chatgpt"',
        '-c',
        'model_provider="openai"',
      ],
      cwd,
      { ...cleanEnv(), ...this.networkEnvironment(), CODEX_HOME: dir },
    ));
    rpc.on('notification', (m) => this.notification(s, m));
    rpc.on('request', (m) => this.request(s, m));
    rt.exit = new Promise((resolve, reject) =>
      rpc.on('closed', (reason) => {
        void this.exited(s, reason, rpc.process.pid).then(resolve, reject);
      }),
    );
    rt.exit.catch(() => {});
    rpc.on('protocolError', (e) => {
      s.error = e;
      this.changed();
    });
    await rpc.initialize();
    // A failed verification is not a signed-out account. Let startup fail cleanly
    // so a network outage cannot show the login card or leave a half-ready agent.
    await this.account(s);
    await this.codexModels(s);
    s.status = 'ready';
    if (s.reference && s.account) await this.loadThread(s);
    this.changed();
  }
  async exited(s: Session, reason: string, pid?: number, quiet = false) {
    const expected = s.status === 'stopping' || quiet;
    s.status = 'stopping';
    this.changed();
    try {
      if (pid) await reapGroup(pid);
    } catch (e) {
      s.error = (e as Error).message;
      this.changed();
      throw e;
    }
    s.status = 'stopped';
    s.approvals = [];
    s.turnId = undefined;
    s.loginPending = false;
    s.activity = undefined;
    settle(s);
    if (!expected) s.error = reason;
    else if (quiet && reason.startsWith('Inicio de sesión completado')) note(s, 'info', reason);
    this.runtimes.delete(s.id);
    this.coordinator.unregister(s.id);
    await fs.promises.rm(path.join(this.state.dataDir, 'runtime', `${s.id}.mcp.json`), {
      force: true,
    });
    this.changed();
  }
  async account(s: Session) {
    const rt = this.runtime(s.id);
    const result = await rt.rpc!.call('account/read', { refreshToken: false });
    s.account =
      result.account?.type === 'chatgpt'
        ? `${result.account.email ?? 'ChatGPT'} · ${result.account.planType ?? 'suscripción'}`
        : undefined;
    if (result.account && result.account.type !== 'chatgpt')
      s.error = 'Este perfil solo permite autenticación ChatGPT. Inicia sesión con tu suscripción.';
    this.changed();
  }
  runtime(id: string) {
    const rt = this.runtimes.get(id);
    if (!rt) throw new Error('Abre el agente primero.');
    return rt;
  }
  async loadThread(s: Session) {
    const rt = this.runtime(s.id);
    const level = this.optimization(s.profile).level;
    if (rt.loaded && rt.optimizationLevel === level) return;
    const params = codexParams(
      resolveCodexModel(mergeCodexConfig(s.codexConfig), s.info?.models ?? []),
      this.project(s.projectId).path,
    ).thread;
    params.config = {
      ...params.config,
      'mcp_servers.agent_desk': { ...(await this.coordinator.config(s.id)), required: true },
    } as any;
    params.developerInstructions = [
      params.developerInstructions,
      coordinationInstructions,
      savingInstructions(level),
    ]
      .filter(Boolean)
      .join('\n\n');
    let r;
    try {
      r = await rt.rpc!.call(
        s.reference ? 'thread/resume' : 'thread/start',
        s.reference ? { ...params, threadId: s.reference } : params,
      );
    } catch (error) {
      // Codex does not persist empty threads. Only replace a missing reference when no user history exists.
      if (
        !s.reference ||
        s.messages.some((m) => m.role === 'user') ||
        !/no rollout found for thread id/.test((error as Error).message)
      )
        throw error;
      r = await rt.rpc!.call('thread/start', params);
    }
    s.reference = r.thread.id;
    rt.loaded = true;
    rt.optimizationLevel = level;
    if (r.thread.turns?.length) {
      const restored: Message[] = [];
      for (const turn of r.thread.turns)
        for (const item of turn.items ?? []) {
          const m = messageFromItem(item);
          if (m) {
            const previous = s.messages.find((old) => old.id === m.id);
            m.attachments = previous?.attachments;
            if (previous?.attachments?.length) m.text = previous.text;
            restored.push(m);
          }
        }
      if (restored.length) s.messages = restored;
    }
    this.changed();
  }
  notification(s: Session, { method, params: p }: any) {
    if (!this.runtimes.has(s.id) || s.status === 'stopping') return;
    if (method === 'account/login/completed') {
      s.loginPending = false;
      this.runtime(s.id).loginId = undefined;
      if (p.success)
        void this.account(s)
          .then(() => this.codexModels(s))
          .catch((e) => {
            s.error = e.message;
            this.changed();
          });
      else
        s.error = `No se ha completado el inicio de sesión. ${p.error ?? 'Puedes volver a intentarlo.'}`;
      this.changed();
      return;
    }
    if (method === 'account/updated') {
      void this.account(s).catch((e) => {
        s.error = e.message;
        this.changed();
      });
      return;
    }
    if (method === 'account/rateLimits/updated') {
      const usage = codexUsage(p);
      const previous = this.accounts.state[s.profile]?.usage;
      if (!usage.windows.length) return;
      usage.windows = [
        ...(previous?.windows ?? []).filter(
          (w) => !usage.windows.some((next) => next.label === w.label),
        ),
        ...usage.windows,
      ];
      this.accounts.setUsage(s.profile, usage);
      return;
    }
    const previousUser =
      p?.item?.type === 'userMessage'
        ? s.messages.find((m) => m.id === p.item.id && m.attachments?.length)
        : undefined;
    const previousUserText = previousUser?.text;
    applyCodexEvent(s, method, p);
    if (previousUser) {
      const updated = s.messages.find((m) => m.id === p.item.id);
      if (updated) {
        updated.attachments = previousUser.attachments;
        updated.text = previousUserText!;
      }
    }
    if (p?.item?.type === 'userMessage' && (!p.threadId || p.threadId === s.reference)) {
      const rt = this.runtime(s.id),
        message = s.messages.find((m) => m.id === p.item.id);
      if (message && rt.pendingImages?.length) {
        message.attachments = rt.pendingImages;
        message.text = rt.pendingUserText ?? message.text;
        rt.pendingImages = undefined;
        rt.pendingUserText = undefined;
      }
    }
    this.changed();
  }
  request(s: Session, m: any) {
    const supported = [
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
      'item/tool/requestUserInput',
      'mcpServer/elicitation/request',
    ];
    if (!supported.includes(m.method)) {
      this.runtime(s.id).rpc!.send({
        id: m.id,
        error: { code: -32601, message: 'Solicitud no compatible con Agent Desk' },
      });
      s.error = `La versión instalada solicita ${m.method}, aún no compatible con Agent Desk. La solicitud se ha rechazado.`;
      this.changed();
      return;
    }
    if (m.params?.threadId && s.reference && m.params.threadId !== s.reference) {
      this.runtime(s.id).rpc!.send({
        id: m.id,
        error: { code: -32602, message: 'Thread no registrado' },
      });
      return;
    }
    if (isCoordinationApproval(m.method, m.params)) {
      this.runtime(s.id).rpc!.respond(m.id, { action: 'accept', content: {} });
      return;
    }
    s.approvals.push({ id: m.id, method: m.method, params: m.params });
    s.status = 'waiting';
    this.changed();
  }
  /** Slash commands answered by the desk itself; everything else goes to the agent. */
  private async command(s: Session, runtime: ClaudeRuntime, text: string) {
    const [name, ...rest] = text.slice(1).split(/\s+/),
      arg = rest.join(' ').trim();
    const info = s.info;
    switch (name) {
      case 'help':
        note(
          s,
          'command',
          [
            'Comandos del escritorio: /clear /cost /context /status /mcp /model /permissions /effort /config /terminal /rename /help',
            `Comandos de Claude Code: ${(info?.commands ?? []).map((c) => '/' + c.name).join(' ')}`,
            'Atajos: @ archivo del proyecto · ↑/↓ mensajes anteriores · ⌘V pega capturas · 1/2/3 responden permisos · ⇧⇥ modo · Esc interrumpe',
          ].join('\n'),
        );
        return true;
      case 'cost': {
        const st = s.stats;
        note(
          s,
          'command',
          st
            ? `Coste: ${st.cost.toFixed(4)} USD · ${st.turns} turnos · ${Math.round(st.inputTokens / 1000)}k tokens de entrada · ${Math.round(st.outputTokens / 1000)}k de salida · ${Math.round(st.durationMs / 1000)}s`
            : 'Aún no hay uso en esta sesión.',
        );
        return true;
      }
      case 'context':
        await runtime.contextReport();
        return true;
      case 'status':
        note(
          s,
          'command',
          [
            `Claude Code ${info?.version ?? ''}`,
            `Cuenta: ${s.account ?? 'sin conectar'}`,
            `Modelo: ${info?.model ?? s.config?.model}`,
            `Permisos: ${info?.permissionMode ?? s.config?.permissionMode}`,
            `Esfuerzo: ${info?.effort ?? 'por defecto'}`,
            `Sesión: ${s.reference}`,
            `Carpeta: ${s.worktree?.cwd ?? this.project(s.projectId).path}`,
            ...(s.worktree ? [`Worktree: ${s.worktree.branch} → ${s.worktree.base}`] : []),
          ].join('\n'),
        );
        return true;
      case 'mcp': {
        const servers: any[] = (await runtime.mcpStatus()) ?? [];
        note(
          s,
          'command',
          servers.length
            ? servers
                .map(
                  (x) =>
                    `${x.name}: ${x.status}${x.tools ? ` · ${x.tools.length} herramientas` : ''}${x.error ? ` · ${x.error}` : ''}`,
                )
                .join('\n')
            : 'No hay servidores MCP configurados en este perfil.',
        );
        return true;
      }
      case 'model': {
        if (!arg) {
          note(s, 'command', `Modelos: ${(info?.models ?? []).map((m) => m.value).join(', ')}`);
          return true;
        }
        await this.configure(s.id, { model: arg });
        return true;
      }
      case 'permissions':
      case 'mode': {
        if (!permissionModes.some((m) => m.id === arg)) {
          note(s, 'command', `Modos: ${permissionModes.map((m) => m.id).join(', ')}`);
          return true;
        }
        await this.configure(s.id, { permissionMode: arg as any });
        return true;
      }
      case 'effort': {
        if (!efforts.some((e) => e.id === arg)) {
          note(s, 'command', `Niveles: ${efforts.map((e) => e.id).join(', ')}`);
          return true;
        }
        await this.configure(s.id, { effort: arg as any });
        return true;
      }
      case 'rename':
        if (arg) this.rename(s.id, arg.slice(0, 80));
        return true;
      case 'clear':
        s.messages = [];
        s.todos = undefined;
        runtime.send('/clear');
        return true;
    }
    return false;
  }
  private usageJobs = new Map<Profile, Promise<void>>();
  networkChanged() {
    this.usageAttempts.clear();
    for (const account of Object.values(this.accounts.state)) account.usage = undefined;
    this.changed();
  }
  private usageAttempts = new Map<Profile, { at: number; revision: number }>();
  refreshUsage(profile: Profile): Promise<void> {
    if (this.accounts.changing(profile)) return Promise.resolve();
    if (['openrouter', 'opencode'].includes(providerKind(profile))) {
      const last = this.usageAttempts.get(profile),
        revision = this.accounts.revision(profile);
      if (last?.revision === revision && Date.now() - last.at < 60000) return Promise.resolve();
      this.usageAttempts.set(profile, { at: Date.now(), revision });
      return this.accounts.refresh(profile);
    }
    if (providerKind(profile) === 'gemini') return Promise.resolve();
    const pending = this.usageJobs.get(profile);
    if (pending) return pending;
    const revision = this.accounts.revision(profile);
    if (isCodex(profile)) {
      const previous = this.usageAttempts.get(profile);
      if (previous?.revision === revision && Date.now() - previous.at < 60000)
        return Promise.resolve();
      this.usageAttempts.set(profile, { at: Date.now(), revision });
    }
    const publish = (usage: import('../src/subscription-usage').SubscriptionUsage) => {
      if (this.accounts.revision(profile) === revision) this.accounts.setUsage(profile, usage);
    };
    const work = (async () => {
      const s = this.state.sessions.find(
        (s) =>
          s.profile === profile &&
          s.status !== 'stopping' &&
          (this.runtimes.get(s.id)?.claude || this.runtimes.get(s.id)?.rpc),
      );
      const rt = s && this.runtimes.get(s.id);
      try {
        if (isCodex(profile)) {
          if (rt?.rpc) publish(codexUsage(await rt.rpc.call('account/rateLimits/read')));
          else await this.accounts.readUsage(profile);
        } else if (rt?.claude) publish(claudeUsage(await rt.claude.subscriptionUsage()));
        else
          publish({
            windows: [],
            checkedAt: Date.now(),
            unavailable:
              'El uso de Claude estará disponible al abrir una conversación de esta cuenta.',
          });
      } catch (e) {
        publish({
          windows: [],
          checkedAt: Date.now(),
          unavailable: (e as Error).message,
        });
      }
    })().finally(() => this.usageJobs.delete(profile));
    this.usageJobs.set(profile, work);
    return work;
  }
  private optimization(profile: Profile): TokenOptimization {
    return this.state.profiles?.find((p) => p.id === profile)?.optimization ?? defaultOptimization;
  }
  configureOptimization(profile: Profile, optimization: TokenOptimization) {
    const account = this.state.profiles?.find((p) => p.id === profile);
    if (!account) throw new Error('La cuenta no existe.');
    account.optimization = { ...optimization };
    this.changed();
    return account.optimization;
  }
  private optimizeTurn(s: Session, text: string, images: PreparedAttachment[]) {
    const base = isCodex(s.profile)
      ? resolveCodexModel(mergeCodexConfig(s.codexConfig), s.info?.models ?? [])
      : mergeConfig(s.config);
    return turnOptimization({
      preferences: this.optimization(s.profile),
      text,
      images: !!images.length,
      hasHistory: s.messages.some((m) => m.role === 'user'),
      planning: !isCodex(s.profile) && s.config?.permissionMode === 'plan',
      models: s.info?.models ?? [],
      baseModel: base.model,
      baseEffort: base.effort,
      previousModel: s.optimization?.model,
      previousEffort: s.optimization?.effort,
    });
  }
  async send(id: string, text: string, images: PreparedAttachment[] = []) {
    if (this.accounts.removing(this.session(id).profile))
      throw new Error('Se está eliminando esta cuenta.');
    if (!this.runtimes.has(id)) await this.start(id);
    return this.exclusive(id, async () => {
      const s = this.session(id),
        rt = this.runtime(id);
      if (rt.provider) {
        if (s.status !== 'ready') throw new Error('Espera a que termine la respuesta.');
        await rt.provider.send(text, images);
        if (s.title.startsWith('Sesión ')) s.title = text.slice(0, 48) || 'Archivo adjunto';
        this.changed();
        return true;
      }
      if (rt.claude) {
        if (!['ready', 'working', 'waiting'].includes(s.status))
          throw new Error('La sesión no está preparada.');
        if (!images.length && text.startsWith('/') && (await this.command(s, rt.claude, text))) {
          this.changed();
          return true;
        }
        if (s.status === 'ready') {
          const decision = this.optimizeTurn(s, text, images);
          if (
            decision.autoModel ||
            decision.level > 0 ||
            s.optimization?.autoModel ||
            s.optimization?.level ||
            rt.optimizedControls
          ) {
            // Keep recovery armed if one control succeeds and the next is rejected.
            rt.optimizedControls = true;
            await rt.claude.setModel(decision.model);
            await rt.claude.setEffort(decision.effort);
            rt.optimizedControls = decision.autoModel || decision.level > 0;
          }
          s.optimization = decision;
        } else if (s.optimization) {
          s.optimization = {
            ...s.optimization,
            reason: 'Petición en cola: conserva el modelo y esfuerzo del proceso en curso',
          };
        }
        this.coordinator.task(id, text);
        s.accountLocked = true;
        rt.claude.send(text, images);
        if (s.title.startsWith('Sesión ') && !text.startsWith('/'))
          s.title = text.slice(0, 48) || 'Archivo adjunto';
        this.changed();
        return true;
      }
      if (!isCodex(s.profile) || s.status !== 'ready')
        throw new Error('La sesión no está preparada para una tarea nueva.');
      await this.account(s);
      if (!s.account)
        throw new Error('Inicia sesión oficialmente con ChatGPT antes de enviar una tarea.');
      await this.loadThread(s);
      const decision = this.optimizeTurn(s, text, images);
      this.coordinator.task(id, text);
      s.optimization = decision;
      s.accountLocked = true;
      s.status = 'working';
      s.error = undefined;
      this.changed();
      try {
        rt.pendingImages = images.map((i) => i.attachment);
        rt.pendingUserText = text;
        await rt.rpc!.call('turn/start', {
          threadId: s.reference,
          input: codexAttachmentContent(text, images),
          ...codexParams(
            { ...mergeCodexConfig(s.codexConfig), model: decision.model, effort: decision.effort },
            this.project(s.projectId).path,
          ).turn,
        });
        s.notice = undefined;
        s.optimization = decision;
        if (s.title.startsWith('Sesión ')) s.title = text.slice(0, 48) || 'Archivo adjunto';
        this.changed();
        return true;
      } catch (e) {
        s.error = (e as Error).message;
        /* A timeout is ambiguous: keep the session locked until interruption or stop. */ if (
          !s.error.startsWith('Tiempo agotado') &&
          !s.turnId
        )
          s.status = 'ready';
        this.changed();
        throw e;
      }
    });
  }
  async configure(id: string, patch: Partial<ClaudeConfig>) {
    const s = this.session(id);
    if (providerKind(s.profile) !== 'claude')
      throw new Error('Esta configuración solo pertenece a Claude.');
    const before = mergeConfig(s.config);
    const next = mergeConfig({ ...before, ...patch });
    const rt = this.runtimes.get(id)?.claude;
    let restart = false;
    if (rt) {
      if (patch.model !== undefined && patch.model !== before.model) await rt.setModel(patch.model);
      if (patch.permissionMode) await rt.setPermissionMode(patch.permissionMode);
      if ('effort' in patch && patch.effort !== before.effort) await rt.setEffort(patch.effort);
      if (
        (patch.thinking && patch.thinking !== before.thinking) ||
        (patch.thinkingBudget !== undefined && patch.thinkingBudget !== before.thinkingBudget)
      )
        await rt.setThinking(
          next.thinking !== 'disabled',
          next.thinking === 'enabled' ? next.thinkingBudget : undefined,
          next.thinkingDisplay,
        );
      restart = Object.keys(patch).some(
        (k) =>
          !liveKeys.includes(k as keyof ClaudeConfig) &&
          JSON.stringify((patch as any)[k]) !== JSON.stringify((before as any)[k]),
      );
      if (restart) s.notice = 'Algunos cambios se aplican al reabrir el agente.';
    }
    s.config = next;
    this.changed();
    return { restart };
  }
  async refreshCodexModels(id: string) {
    const s = this.session(id);
    if (!isCodex(s.profile)) throw new Error('El catálogo pertenece a Codex.');
    return this.refreshModels(id);
  }
  async selectedModels(profile: Profile, signal?: AbortSignal) {
    const models = await this.accounts.readModels(profile, signal ?? new AbortController().signal);
    const selection = this.state.profiles?.find((p) => p.id === profile)?.modelSelection;
    if (!['openrouter', 'opencode'].includes(providerKind(profile))) return models;
    return models.filter(
      (m) => selection?.models.includes(m.value) && (!selection.freeOnly || m.free),
    );
  }
  async selectProviderModels(profile: Profile, selection: ModelSelection) {
    const p = this.state.profiles?.find((p) => p.id === profile);
    if (!p || !['openrouter', 'opencode'].includes(p.kind) || this.accounts.changing(profile))
      throw new Error('La cuenta no está disponible.');
    if (
      this.state.sessions.some(
        (s) =>
          s.profile === profile &&
          ['working', 'waiting', 'starting', 'stopping'].includes(s.status),
      )
    )
      throw new Error('Espera a que termine la tarea antes de cambiar los modelos.');
    p.modelSelection = { ...selection, models: [...new Set(selection.models)] };
    this.store.flush();
    for (const s of this.state.sessions.filter((s) => s.profile === profile)) {
      s.info = undefined;
      s.modelsError = undefined;
      if (!selection.models.includes(s.providerConfig?.model ?? ''))
        s.providerConfig = { model: 'default' };
    }
    this.changed();
    return true;
  }
  async configureProvider(id: string, config: ProviderConfig) {
    const s = this.session(id);
    if (!isConnectedProvider(s.profile)) throw new Error('Proveedor incompatible.');
    if (['working', 'waiting', 'starting', 'stopping'].includes(s.status))
      throw new Error('Espera a que termine la respuesta.');
    if (config.model !== 'default' && !s.info?.models.some((m) => m.value === config.model))
      throw new Error('Actualiza el catálogo y elige un modelo disponible.');
    s.providerConfig = config;
    this.changed();
    return true;
  }
  async refreshModels(id: string) {
    const s = this.session(id);
    this.project(s.projectId);
    if (this.modelJobs.has(id)) return this.modelJobs.get(id)!.work;
    if (this.runtimes.get(id)?.rpc) return this.codexModels(s);
    const controller = new AbortController();
    s.modelsLoading = true;
    s.modelsError = undefined;
    this.changed();
    const work = Promise.resolve().then(async () => {
      try {
        const models = await this.selectedModels(s.profile, controller.signal);
        if (controller.signal.aborted || !this.state.sessions.includes(s)) return;
        s.info ??= {
          tools: [],
          commands: [],
          models: [],
          mcpServers: [],
          skills: [],
          plugins: [],
          agents: [],
          outputStyles: [],
        };
        s.info.models = models;
        if (!models.length)
          s.modelsError = 'No hay modelos disponibles. Comprueba la cuenta y actualiza la lista.';
      } catch (e) {
        if (!controller.signal.aborted)
          s.modelsError = `No se pudo consultar los modelos. ${(e as Error).message}`;
      } finally {
        s.modelsLoading = false;
        this.modelJobs.delete(id);
        this.changed();
      }
    });
    this.modelJobs.set(id, { controller, work });
    return work;
  }
  /** The official server owns the catalogue, including pagination and default reasoning effort. */
  async codexModels(s: Session) {
    const rt = this.runtimes.get(s.id);
    if (!rt?.rpc || s.modelsLoading) return;
    s.modelsLoading = true;
    s.modelsError = undefined;
    this.changed();
    try {
      const models = await fetchCodexModels((method, params) => rt.rpc!.call(method, params));
      if (this.runtimes.get(s.id) !== rt) return;
      const info = (s.info ??= {
        tools: [],
        commands: [],
        models: [],
        mcpServers: [],
        skills: [],
        plugins: [],
        agents: [],
        outputStyles: [],
      });
      info.models = models;
      s.codexConfig = selectCodexConfig(mergeCodexConfig(s.codexConfig), {}, models);
      if (!models.length)
        s.modelsError =
          'Codex no ha devuelto modelos. Comprueba el acceso con ChatGPT y vuelve a actualizar.';
    } catch (e) {
      s.modelsError = `No se ha podido cargar el catálogo de modelos. ${(e as Error).message}`;
    } finally {
      s.modelsLoading = false;
      this.changed();
    }
  }
  async configureCodex(id: string, patch: Partial<CodexConfig>) {
    const s = this.session(id);
    if (!isCodex(s.profile)) throw new Error('Esta configuración es de Codex.');
    const before = mergeCodexConfig(s.codexConfig);
    s.codexConfig = selectCodexConfig(before, patch, s.info?.models ?? []);
    const rt = this.runtimes.get(id);
    const restart = !!(
      rt?.loaded &&
      patch.developerInstructions !== undefined &&
      patch.developerInstructions !== before.developerInstructions
    );
    if (restart) s.notice = 'Las instrucciones se aplican al reabrir el agente.';
    // Access is overridden by turn/start. The running turn keeps its existing grant.
    else if (patch.sandbox !== undefined || patch.approvalPolicy !== undefined)
      s.notice =
        s.status === 'working' || s.status === 'waiting'
          ? 'El nuevo modo de permisos se aplicará al siguiente mensaje. Para autorizar la acción pendiente, responde a su solicitud.'
          : undefined;
    this.changed();
    return { restart };
  }
  async contextUsage(id: string) {
    const rt = this.runtime(id).claude;
    if (!rt) throw new Error('Solo disponible en el chat de Claude.');
    return rt.refreshContext();
  }
  async interrupt(id: string) {
    const s = this.session(id),
      rt = this.runtime(id);
    if (rt.provider) {
      await rt.provider.interrupt();
      return;
    }
    if (rt.pty) {
      rt.pty.write('\x03');
      return;
    }
    if (rt.claude) {
      await rt.claude.interrupt();
      this.changed();
      return;
    }
    if (!s.turnId)
      throw new Error('Aún no hay un turno confirmado. Cierra la pestaña si no responde.');
    await rt.rpc!.call('turn/interrupt', { threadId: s.reference, turnId: s.turnId });
  }
  async stop(id: string) {
    return this.exclusive(id, () => this.stopRuntime(id));
  }
  private stopRuntime(id: string) {
    const pending = this.stoppingRuntimes.get(id);
    if (pending) return pending;
    const work = this.stopRuntimeNow(id).finally(() => this.stoppingRuntimes.delete(id));
    this.stoppingRuntimes.set(id, work);
    return work;
  }
  private async stopRuntimeNow(id: string) {
    const s = this.session(id),
      rt = this.runtimes.get(id);
    if (!rt) return;
    s.status = 'stopping';
    this.changed();
    if (rt.provider) {
      await rt.provider.stop();
      this.runtimes.delete(id);
      this.coordinator.unregister(id);
      s.status = 'stopped';
      s.approvals = [];
      this.changed();
    } else if (rt.rpc) {
      await rt.rpc.stop();
      await rt.exit;
    } else if (rt.claude) {
      await rt.claude.stop();
    } else if (rt.pty) {
      const terminal = rt.pty;
      const signal = (signal: NodeJS.Signals) => {
        try {
          process.kill(-terminal.pid, signal);
        } catch {
          try {
            terminal.kill(signal);
          } catch {}
        }
      };
      signal('SIGTERM');
      const force = setTimeout(() => signal('SIGKILL'), 2500);
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          rt.exit,
          new Promise(
            (_, reject) =>
              (timeout = setTimeout(
                () =>
                  reject(
                    new Error(
                      'No se ha confirmado la salida de Claude. La carpeta sigue bloqueada.',
                    ),
                  ),
                6500,
              )),
          ),
        ]);
      } finally {
        clearTimeout(force);
        clearTimeout(timeout);
      }
    }
  }
  async login(id: string) {
    const s = this.session(id),
      rt = this.runtimes.get(id);
    if (this.accounts.changing(s.profile))
      throw new Error('Ya hay una operación de cuenta en Ajustes.');
    if (isConnectedProvider(s.profile)) throw new Error('Gestiona esta cuenta en Ajustes.');
    if (!isCodex(s.profile)) {
      if (rt?.pty) {
        if (!rt.loginOnly) rt.pty.write('/login\r');
        return;
      }
      if (rt) throw new Error('Detén el agente antes de iniciar sesión.');
      await this.start(id, true);
      return;
    }
    const codex = this.runtime(id);
    if (this.state.sessions.some((other) => other.profile === s.profile && other.loginPending))
      throw new Error(
        'Ya hay un inicio de sesión de ChatGPT pendiente en otra sesión. Complétalo o cancélalo primero.',
      );
    s.error = undefined;
    const r = await codex.rpc!.call('account/login/start', { type: 'chatgpt' });
    codex.loginId = r.loginId;
    s.loginPending = true;
    this.changed();
    return r.authUrl as string;
  }
  async cancelLogin(id: string) {
    const s = this.session(id),
      rt = this.runtime(id);
    if (rt.loginId) await rt.rpc!.call('account/login/cancel', { loginId: rt.loginId });
    s.loginPending = false;
    this.changed();
  }
  approve(
    id: string,
    requestId: string | number,
    decision: 'accept' | 'always' | 'decline',
    answers?: Record<string, string>,
    message?: string,
  ) {
    const s = this.session(id),
      rt = this.runtime(id);
    if (rt.provider) {
      rt.provider.approve(requestId, decision);
      return;
    }
    if (rt.claude) {
      rt.claude.approve(requestId, decision, answers, message);
      this.changed();
      return;
    }
    const a = s.approvals.find((a) => a.id === requestId);
    if (!a) throw new Error('La solicitud ya no está pendiente.');
    const result = approvalResult(a.method, a.params, decision, answers);
    rt.rpc!.respond(requestId, result);
    s.approvals = s.approvals.filter((x) => x !== a);
    s.status = s.approvals.length ? 'waiting' : 'working';
    this.changed();
  }
  private insideRepository(root: string, folder: string) {
    const relative = path.relative(root, folder);
    return (
      relative === '' ||
      (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
    );
  }
  /** Agents working directly in the main checkout of `root` (isolated chats do not count). */
  private sharedAgents(root: string) {
    return this.state.sessions.filter(
      (s) =>
        !s.worktree &&
        this.insideRepository(root, this.project(s.projectId).path) &&
        (this.runtimes.has(s.id) || this.operations.has(s.id)),
    );
  }
  async diff(id: string, sessionId?: string) {
    const project = this.project(id);
    const s = sessionId ? this.session(sessionId) : undefined;
    if (s && s.projectId !== id) throw new Error('La sesión pertenece a otro proyecto.');
    if (!s?.worktree) return readGit(project.path);
    const status = await worktreeStatus(s.worktree);
    const snapshot = status.exists ? await readGit(s.worktree.cwd) : await readGit(project.path);
    return { ...snapshot, worktree: status };
  }
  setIsolation(id: string, isolation: 'worktree' | 'shared') {
    const s = this.session(id);
    if (!canIsolate(s)) throw new Error('El aislamiento en worktree está disponible para Claude.');
    if (active(s)) throw new Error('Detén el chat antes de cambiar su carpeta de trabajo.');
    if (isolationLocked(s))
      throw new Error(
        s.worktree
          ? 'Este chat ya tiene un worktree. Fusiónalo o descártalo desde la barra de Git.'
          : 'Este chat ya ha trabajado en la carpeta compartida. Duplícalo para aislar una copia.',
      );
    s.isolation = isolation;
    this.changed();
    return true;
  }
  /** Merge into the base branch, bring the base in, or remove the chat's worktree and branch. */
  async worktree(id: string, operation: 'merge' | 'update' | 'discard') {
    return this.exclusive(id, async () => {
      const s = this.session(id);
      const worktree = s.worktree;
      if (!worktree) throw new Error('Este chat no está aislado en un worktree.');
      if (this.gitJobs.has(worktree.root)) throw new Error('Hay una operación de Git en curso.');
      if (
        operation !== 'discard' &&
        ['starting', 'working', 'waiting', 'stopping'].includes(s.status)
      )
        throw new Error('Espera a que el agente termine el turno.');
      if (operation === 'merge') {
        const others = this.sharedAgents(worktree.root).filter((o) => o.id !== id);
        if (others.length)
          throw new Error(
            'Hay agentes trabajando en la copia principal. Detenlos antes de fusionar en ella.',
          );
      }
      this.gitJobs.add(worktree.root);
      const work = (async () => {
        if (operation === 'discard') {
          await this.stopRuntime(id);
          if (this.runtimes.has(id))
            throw new Error('No se ha confirmado el cierre del agente. Vuelve a intentarlo.');
          await removeWorktree(worktree);
          s.worktree = undefined;
          this.store.flush();
          note(s, 'info', `Worktree ${worktree.branch} descartado.`);
          return { merged: false, message: `Worktree ${worktree.branch} descartado.` };
        }
        const result =
          operation === 'merge'
            ? await mergeWorktree(worktree, s.title)
            : await updateWorktree(worktree, s.title);
        note(
          s,
          result.conflicts?.length ? 'warning' : 'info',
          result.conflicts?.length
            ? `${result.message}\n${result.conflicts.join('\n')}`
            : result.message,
        );
        return result;
      })();
      this.gitWork.add(work);
      try {
        return await work;
      } finally {
        this.gitJobs.delete(worktree.root);
        this.gitWork.delete(work);
        this.changed();
      }
    });
  }
  /**
   * Duplicate a Claude chat: same history (forkSession on first start) in a new tab, isolated in
   * its own worktree that starts from the source's current files.
   */
  async fork(id: string, isolate: boolean) {
    const source = this.session(id);
    if (!canIsolate(source)) throw new Error('Duplicar chats está disponible para Claude.');
    const origin = source.forkFrom ?? (source.attempted ? source.reference : undefined);
    if (!origin) throw new Error('Envía al menos un mensaje antes de duplicar el chat.');
    if (['starting', 'working', 'waiting', 'stopping'].includes(source.status))
      throw new Error('Espera a que termine el turno para duplicar el chat.');
    const project = this.project(source.projectId);
    let worktree: Session['worktree'];
    let warning: string | undefined;
    if (isolate) {
      const root = await repositoryRoot(project.path).catch(() => undefined);
      if (root && this.gitJobs.has(root)) throw new Error('Hay una operación de Git en curso.');
      if (root) this.gitJobs.add(root);
      try {
        if (source.worktree) {
          if (!['ready', 'stopped', 'error'].includes(source.status))
            throw new Error('Espera a que termine el turno para duplicar el chat.');
          // Snapshot the source's files so both approaches start from the same point.
          await commitWorktree(source.worktree, `Agent Desk: punto de partida de ${source.title}`);
        }
        worktree = await createWorktree({
          project: project.path,
          dataDir: this.state.dataDir,
          title: `${source.title} copia`,
          id: randomUUID(),
          from: source.worktree,
        });
      } catch (error) {
        if (source.worktree || root) throw error;
        warning = `No se ha podido aislar la copia en un worktree: ${(error as Error).message} Comparte la carpeta con los demás agentes.`;
      } finally {
        if (root) this.gitJobs.delete(root);
      }
    }
    const fork = this.newSession(source.projectId, source.profile, source.mode);
    Object.assign(fork, {
      title: `${source.title} (copia)`.slice(0, 80),
      config: structuredClone(source.config),
      forkFrom: origin,
      forkOf: source.id,
      accountLocked: true,
      isolation: worktree ? 'worktree' : 'shared',
      worktree,
      // The fork starts without file checkpoints: earlier turns cannot be rewound there.
      messages: structuredClone(source.messages).map((m) => ({ ...m, checkpoint: undefined })),
    } satisfies Partial<Session>);
    note(
      fork,
      warning ? 'warning' : 'info',
      warning ??
        (worktree
          ? `Copia de «${source.title}» en el worktree ${worktree.branch}. Sigue desde aquí con otro enfoque; los cambios se fusionan en ${worktree.base}.${source.worktree ? '' : ' Parte del último commit: los cambios sin commit de la carpeta compartida no se copian.'}`
          : `Copia de «${source.title}». Comparte la carpeta del proyecto.`),
    );
    this.store.flush();
    this.changed();
    return fork;
  }
  /** Undo the files Claude's tools changed since `messageId` was sent (this turn and later). */
  async rewind(id: string, messageId: string, dryRun = false) {
    const s = this.session(id);
    if (!canIsolate(s)) throw new Error('Deshacer cambios está disponible en el chat de Claude.');
    const message = s.messages.find((m) => m.id === messageId && m.role === 'user');
    if (!message?.checkpoint)
      throw new Error('Este mensaje no tiene un punto de restauración de archivos.');
    if (!this.runtimes.get(id)?.claude) await this.start(id);
    return this.exclusive(id, async () => {
      const rt = this.runtime(id).claude;
      if (!rt) throw new Error('Solo disponible en el chat de Claude.');
      if (s.status !== 'ready')
        throw new Error('Espera a que termine el turno o interrúmpelo antes de deshacer cambios.');
      const result = await rt.rewindFiles(message.checkpoint!, dryRun);
      if (!result.canRewind)
        throw new Error(result.error ?? 'No hay cambios de archivos que deshacer en este turno.');
      if (!dryRun) {
        const files = result.filesChanged?.length ?? 0;
        note(
          s,
          'info',
          files
            ? `Archivos restaurados al estado anterior a «${message.text.slice(0, 60)}»: ${files} archivos (+${result.insertions ?? 0} −${result.deletions ?? 0}).${result.skippedLinks ? ` ${result.skippedLinks} enlaces no se han tocado.` : ''}`
            : 'No había cambios de archivos que deshacer.',
        );
        this.changed();
      }
      return result;
    });
  }
  async gitOperation(id: string, operation: GitOperation, value?: string) {
    const cwd = this.project(id).path;
    const root = await repositoryRoot(cwd);
    if (!root) throw new Error('Esta carpeta no es un repositorio Git.');
    if (this.gitJobs.has(root)) throw new Error('Hay una operación de Git en curso.');
    if (operation !== 'fetch' && this.sharedAgents(root).length)
      throw new Error('Detén los agentes de este repositorio antes de modificar Git.');
    this.gitJobs.add(root);
    const work = changeGit(cwd, operation, value);
    this.gitWork.add(work);
    try {
      return await work;
    } finally {
      this.gitJobs.delete(root);
      this.gitWork.delete(work);
    }
  }
  async shutdown() {
    for (const job of this.modelJobs.values()) job.controller.abort();
    await Promise.allSettled([...this.modelJobs.values()].map((job) => job.work));
    await Promise.allSettled([...this.removingProjects.values()]);
    await Promise.allSettled([...this.gitWork]);
    const accountResults = await this.accounts.shutdown();
    const terminalResults = await this.terminals.shutdown();
    const results = await Promise.allSettled([...this.runtimes.keys()].map((id) => this.stop(id)));
    if ([...accountResults, ...terminalResults, ...results].every((r) => r.status === 'fulfilled'))
      await this.coordinator.close();
    this.store.flush();
    return [...accountResults, ...terminalResults, ...results];
  }
}
