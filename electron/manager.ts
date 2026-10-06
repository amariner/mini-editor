import { codexImageContent, type PreparedImage } from './attachments';
import { codexUsage, claudeUsage } from '../src/subscription-usage';
import { isCodex } from '../src/shared';
import { fetchCodexModels, selectCodexConfig, resolveCodexModel } from './codex-models';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as pty from 'node-pty';
import type {
  ClaudeConfig,
  CodexConfig,
  DeskEvent,
  Message,
  Profile,
  Session,
} from '../src/shared';
import { efforts, permissionModes, profiles, type ProfileDefinition } from '../src/shared';
import { Store } from './store';
import { Coordinator, coordinationInstructions, isCoordinationApproval } from './coordination';
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
const exec = promisify(execFile);
type Runtime = {
  pendingImages?: import('../src/shared').ImageAttachment[];
  rpc?: Rpc;
  pty?: pty.IPty;
  claude?: ClaudeRuntime;
  loginOnly?: boolean;
  buffer: string;
  sequence: number;
  loginId?: string;
  loaded?: boolean;
  exit?: Promise<void>;
};
/** Configuration keys the SDK can change while the agent runs. The rest need a restart. */
const liveKeys: (keyof ClaudeConfig)[] = [
  'model',
  'permissionMode',
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
  private eventTimer?: NodeJS.Timeout;
  /** `profilesRoot` lets tests reuse authenticated profiles with an isolated state file. */
  constructor(
    root: string,
    private emit: (e: DeskEvent) => void,
    readonly profilesRoot = root,
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
    );
    for (const p of this.state.profiles ?? profiles) this.accounts.register(p.id);
  }
  get state() {
    return this.store.state;
  }
  addAccount(kind: 'claude' | 'codex', name?: string) {
    const definitions = (this.state.profiles ??= profiles.map((p) => ({ ...p })));
    if (definitions.length >= 100) throw new Error('Has alcanzado el límite de 100 perfiles.');
    let index = kind === 'claude' ? 3 : 2;
    while (definitions.some((p) => p.id === `${kind}-${index}`)) index++;
    const definition: ProfileDefinition = {
      id: `${kind}-${index}` as Profile,
      name: name?.trim() || `${kind === 'claude' ? 'Claude' : 'Codex'} ${index}`,
      kind,
    };
    definitions.push(definition);
    this.accounts.register(definition.id);
    this.store.flush();
    this.changed();
    return definition;
  }
  get canRestart() {
    return this.runtimes.size === 0 && this.operations.size === 0 && !this.accounts.active;
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
    const p = this.state.projects.find((p) => p.id === id);
    if (!p) throw new Error('Proyecto desconocido.');
    return p;
  }
  async discover() {
    for (const name of ['claude', 'codex'] as const) {
      if (this.state.tools[name] && fs.existsSync(this.state.tools[name]!)) continue;
      const home = cleanEnv().HOME ?? '';
      const paths = [
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
  async addProject(folder: string) {
    const canonical = await fs.promises.realpath(folder);
    if (!(await fs.promises.stat(canonical)).isDirectory())
      throw new Error('Selecciona una carpeta.');
    let project = this.state.projects.find((p) => p.path === canonical);
    if (!project) {
      project = { id: randomUUID(), name: path.basename(canonical), path: canonical };
      this.state.projects.push(project);
    }
    this.select(project.id, undefined, 'claude-1');
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
    if (!s) s = this.newSession(projectId, profile ?? 'claude-1');
    this.state.selectedProject = projectId;
    this.state.selectedSession = s.id;
    this.changed();
    return s;
  }
  newSession(projectId: string, profile: Profile, mode?: 'chat' | 'terminal') {
    this.project(projectId);
    if (!(this.state.profiles ?? profiles).some((p) => p.id === profile))
      throw new Error('Esta cuenta no existe. Añádela en Ajustes.');
    const count =
      this.state.sessions.filter((s) => s.projectId === projectId && s.profile === profile).length +
      1;
    const previous = [...this.state.sessions]
      .reverse()
      .find((s) => s.projectId === projectId && s.profile === profile);
    const s: Session = {
      id: randomUUID(),
      projectId,
      profile,
      title: `Sesión ${count}`,
      reference: isCodex(profile) ? undefined : randomUUID(),
      mode: isCodex(profile) ? undefined : (mode ?? 'chat'),
      config: isCodex(profile) ? undefined : mergeConfig(previous?.config),
      codexConfig: isCodex(profile) ? mergeCodexConfig(previous?.codexConfig) : undefined,
      status: 'stopped',
      messages: [],
      approvals: [],
    };
    this.state.sessions.push(s);
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
    if (isCodex(s.profile)) throw new Error('Codex solo tiene chat.');
    if (active(s)) throw new Error('Detén la sesión antes de cambiar entre chat y terminal.');
    s.mode = mode;
    this.changed();
  }
  async removeProject(id: string) {
    if (
      this.state.sessions.some(
        (s) => s.projectId === id && (active(s) || this.operations.has(s.id)),
      )
    )
      throw new Error('Detén las sesiones del proyecto antes de quitarlo.');
    await this.terminals.stop(id);
    this.state.projects = this.state.projects.filter((p) => p.id !== id);
    this.state.sessions = this.state.sessions.filter((s) => s.projectId !== id);
    if (this.state.selectedProject === id) {
      this.state.selectedProject = undefined;
      this.state.selectedSession = undefined;
      if (this.state.projects[0]) this.select(this.state.projects[0].id);
    }
    this.changed();
  }
  async exclusive<T>(id: string, fn: () => Promise<T>) {
    if (this.operations.has(id)) throw new Error('Hay una operación pendiente en esta sesión.');
    this.operations.add(id);
    try {
      return await fn();
    } finally {
      this.operations.delete(id);
    }
  }
  async start(id: string, loginOnly = false) {
    return this.exclusive(id, async () => {
      const s = this.session(id),
        project = this.project(s.projectId);
      if (this.accounts.changing(s.profile) && this.accounts.state[s.profile].busy !== 'checking')
        throw new Error(
          'Completa la operación de esta cuenta en Ajustes antes de abrir el agente.',
        );
      if (this.runtimes.has(id)) return;
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
      this.coordinator.register(s, project.path);
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
          await this.startClaude(s, rt, binary, dir, project.path);
        else await this.startTerminal(s, rt, binary, dir, project.path, loginOnly);
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
        s.status = 'error';
        this.changed();
        throw e;
      }
    });
  }
  private async startClaude(s: Session, rt: Runtime, binary: string, dir: string, cwd: string) {
    const options = claudeOptions(s, { cwd, binary, profileDir: dir });
    options.mcpServers = {
      agent_desk: { type: 'stdio', ...(await this.coordinator.config(s.id)) },
    };
    options.systemPrompt = {
      type: 'preset',
      preset: 'claude_code',
      append: [s.config?.appendSystemPrompt, coordinationInstructions].filter(Boolean).join('\n\n'),
    };
    options.hooks = {
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
      terminalArgs.push(
        '--mcp-config',
        mcpFile,
        '--append-system-prompt',
        coordinationInstructions,
      );
    }
    const terminal = (rt.pty = pty.spawn(binary, terminalArgs, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd,
      env: { ...cleanEnv(), CLAUDE_CONFIG_DIR: dir },
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
      { ...cleanEnv(), CODEX_HOME: dir },
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
    try {
      await this.account(s);
    } catch (e) {
      s.account = undefined;
      s.error = (e as Error).message;
    }
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
    if (rt.loaded) return;
    const params = codexParams(
      resolveCodexModel(mergeCodexConfig(s.codexConfig), s.info?.models ?? []),
      this.project(s.projectId).path,
    ).thread;
    params.config = {
      ...params.config,
      'mcp_servers.agent_desk': { ...(await this.coordinator.config(s.id)), required: true },
    } as any;
    params.developerInstructions = [params.developerInstructions, coordinationInstructions]
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
    if (r.thread.turns?.length) {
      const restored: Message[] = [];
      for (const turn of r.thread.turns)
        for (const item of turn.items ?? []) {
          const m = messageFromItem(item);
          if (m) {
            m.attachments = s.messages.find((old) => old.id === m.id)?.attachments;
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
    applyCodexEvent(s, method, p);
    if (p?.item?.type === 'userMessage' && (!p.threadId || p.threadId === s.reference)) {
      const rt = this.runtime(s.id),
        message = s.messages.find((m) => m.id === p.item.id);
      if (message && rt.pendingImages?.length) {
        message.attachments = rt.pendingImages;
        rt.pendingImages = undefined;
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
            `Carpeta: ${this.project(s.projectId).path}`,
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
  refreshUsage(profile: Profile): Promise<void> {
    if (this.accounts.changing(profile)) return Promise.resolve();
    const pending = this.usageJobs.get(profile);
    if (pending) return pending;
    const revision = this.accounts.revision(profile);
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
          unavailable: isCodex(profile)
            ? 'Codex no pudo consultar la cuota de suscripción.'
            : (e as Error).message,
        });
      }
    })().finally(() => this.usageJobs.delete(profile));
    this.usageJobs.set(profile, work);
    return work;
  }
  async send(id: string, text: string, images: PreparedImage[] = []) {
    this.session(id);
    if (!this.runtimes.has(id)) await this.start(id);
    return this.exclusive(id, async () => {
      const s = this.session(id),
        rt = this.runtime(id);
      if (rt.claude) {
        if (!['ready', 'working', 'waiting'].includes(s.status))
          throw new Error('La sesión no está preparada.');
        if (!images.length && text.startsWith('/') && (await this.command(s, rt.claude, text))) {
          this.changed();
          return true;
        }
        this.coordinator.task(id, text);
        rt.claude.send(text, images);
        if (s.title.startsWith('Sesión ') && !text.startsWith('/'))
          s.title = text.slice(0, 48) || 'Imagen adjunta';
        this.changed();
        return true;
      }
      if (!isCodex(s.profile) || s.status !== 'ready')
        throw new Error('La sesión no está preparada para una tarea nueva.');
      await this.account(s);
      if (!s.account)
        throw new Error('Inicia sesión oficialmente con ChatGPT antes de enviar una tarea.');
      await this.loadThread(s);
      this.coordinator.task(id, text);
      s.status = 'working';
      s.error = undefined;
      this.changed();
      try {
        rt.pendingImages = images.map((i) => i.attachment);
        await rt.rpc!.call('turn/start', {
          threadId: s.reference,
          input: codexImageContent(text, images),
          ...codexParams(
            resolveCodexModel(mergeCodexConfig(s.codexConfig), s.info?.models ?? []),
            this.project(s.projectId).path,
          ).turn,
        });
        if (s.title.startsWith('Sesión ')) s.title = text.slice(0, 48) || 'Imagen adjunta';
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
    if (isCodex(s.profile)) throw new Error('Codex no tiene esta configuración.');
    const before = mergeConfig(s.config);
    s.config = mergeConfig({ ...before, ...patch });
    const rt = this.runtimes.get(id)?.claude;
    let restart = false;
    if (rt) {
      if (patch.model !== undefined && patch.model !== before.model) await rt.setModel(patch.model);
      if (patch.permissionMode && patch.permissionMode !== before.permissionMode)
        await rt.setPermissionMode(patch.permissionMode);
      if ('effort' in patch && patch.effort !== before.effort) await rt.setEffort(patch.effort);
      if (
        (patch.thinking && patch.thinking !== before.thinking) ||
        (patch.thinkingBudget !== undefined && patch.thinkingBudget !== before.thinkingBudget)
      )
        await rt.setThinking(
          s.config.thinking !== 'disabled',
          s.config.thinking === 'enabled' ? s.config.thinkingBudget : undefined,
          s.config.thinkingDisplay,
        );
      restart = Object.keys(patch).some(
        (k) =>
          !liveKeys.includes(k as keyof ClaudeConfig) &&
          JSON.stringify((patch as any)[k]) !== JSON.stringify((before as any)[k]),
      );
      if (restart) s.notice = 'Algunos cambios se aplican al reabrir el agente.';
    }
    this.changed();
    return { restart };
  }
  async refreshCodexModels(id: string) {
    const s = this.session(id);
    if (!isCodex(s.profile)) throw new Error('El catálogo pertenece a Codex.');
    if (!this.runtimes.get(id)?.rpc)
      throw new Error('Abre el agente Codex para consultar sus modelos.');
    await this.codexModels(s);
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
    const restart =
      !!rt &&
      !!rt.loaded &&
      ((patch.sandbox !== undefined && patch.sandbox !== before.sandbox) ||
        (patch.developerInstructions !== undefined &&
          patch.developerInstructions !== before.developerInstructions));
    if (restart) s.notice = 'El sandbox y las instrucciones se aplican al reabrir el agente.';
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
    return this.exclusive(id, async () => {
      const s = this.session(id),
        rt = this.runtimes.get(id);
      if (!rt) return;
      s.status = 'stopping';
      this.changed();
      if (rt.rpc) {
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
    });
  }
  async login(id: string) {
    const s = this.session(id),
      rt = this.runtimes.get(id);
    if (this.accounts.changing(s.profile))
      throw new Error('Ya hay una operación de cuenta en Ajustes.');
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
  async diff(id: string) {
    const cwd = this.project(id).path;
    try {
      const options = {
        cwd,
        env: { ...cleanEnv(), GIT_OPTIONAL_LOCKS: '0' },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 10000,
      };
      const [status, unstaged, staged] = await Promise.all([
        exec('git', ['--no-optional-locks', 'status', '--short'], options),
        exec('git', ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--'], options),
        exec(
          'git',
          ['--no-pager', 'diff', '--cached', '--no-ext-diff', '--no-textconv', '--'],
          options,
        ),
      ]);
      const [branch, stats] = await Promise.all([
        exec('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], options)
          .then((result) => result.stdout.trim())
          .catch(() => 'HEAD separado'),
        Promise.all([
          exec(
            'git',
            ['--no-pager', 'diff', '--numstat', '--no-ext-diff', '--no-textconv', '--'],
            options,
          ),
          exec(
            'git',
            ['--no-pager', 'diff', '--cached', '--numstat', '--no-ext-diff', '--no-textconv', '--'],
            options,
          ),
        ]).catch(() => undefined),
      ]);
      const lines = stats
        ?.flatMap((result) => result.stdout.split('\n'))
        .reduce(
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
      return {
        status: status.stdout,
        unstaged: unstaged.stdout,
        staged: staged.stdout,
        branch,
        lines,
      };
    } catch (e) {
      throw new Error(
        `No se pudo consultar Git. Comprueba que la carpeta sea un repositorio. ${(e as Error).message.slice(0, 250)}`,
      );
    }
  }
  async shutdown() {
    const accountResults = await this.accounts.shutdown();
    const terminalResults = await this.terminals.shutdown();
    const results = await Promise.allSettled([...this.runtimes.keys()].map((id) => this.stop(id)));
    if ([...accountResults, ...terminalResults, ...results].every((r) => r.status === 'fulfilled'))
      await this.coordinator.close();
    this.store.flush();
    return [...accountResults, ...terminalResults, ...results];
  }
}
