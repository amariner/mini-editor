import { claudeImageContent, type PreparedImage } from './attachments';
import { browserInput } from '../src/browser-protocol';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Approval, Session } from '../src/shared';
import { applyClaudeMessage, note, settle } from './claude-events';
import { permissionResult } from './core';
import { coordinationInput } from './coordination';
/* The SDK is an ES module; the main process is bundled as CommonJS. A real dynamic import keeps
   Node's ESM loader in charge instead of letting the bundler rewrite it into require(). */
const importModule = new Function('u', 'return import(u)') as (u: string) => Promise<any>;
let sdkPromise: Promise<any> | undefined;
function sdk() {
  /* Resolve from the bundle location when bundled, from the project root under tsx. */
  const from =
    typeof __filename === 'string' ? __filename : path.join(process.cwd(), 'package.json');
  return (sdkPromise ??= importModule(
    pathToFileURL(createRequire(from).resolve('@anthropic-ai/claude-agent-sdk')).href,
  ));
}
/** Query initialization only: no prompt, conversation persistence, tools or project hooks. */
export async function readClaudeModels(
  binary: string,
  cwd: string,
  env: Record<string, string>,
  signal: AbortSignal,
) {
  const { query } = await sdk();
  signal.throwIfAborted();
  const controller = new AbortController();
  let wake: (() => void) | undefined;
  let request: any;
  const cancel = () => {
    controller.abort();
    wake?.();
    request?.close();
  };
  signal.addEventListener('abort', cancel, { once: true });
  let timeout: NodeJS.Timeout | undefined;
  try {
    request = query({
      prompt: (async function* () {
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (controller.signal.aborted) resolve();
        });
      })(),
      options: {
        cwd,
        env,
        pathToClaudeCodeExecutable: binary,
        abortController: controller,
        persistSession: false,
        settingSources: [],
        tools: [],
        mcpServers: {},
        permissionMode: 'dontAsk',
      },
    });
    const result: any = await Promise.race([
      request.initializationResult(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error('Tiempo agotado al consultar Claude. Vuelve a actualizar los modelos.'),
            ),
          60000,
        );
        controller.signal.addEventListener(
          'abort',
          () => reject(new Error('Consulta cancelada.')),
          { once: true },
        );
      }),
    ]);
    return (result.models ?? []).map((m: any) => ({
      value: m.value,
      displayName: m.displayName,
      description: m.description ?? '',
      supportedEffortLevels: m.supportedEffortLevels,
    }));
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
    cancel();
  }
}
type Pending = { resolve: (r: unknown) => void; signal: AbortSignal };
/** One long-lived Agent SDK query per open session. Messages are queued into its prompt stream. */
export class ClaudeRuntime {
  private controller = new AbortController();
  private query: any;
  private queue: any[] = [];
  private wake?: () => void;
  private closed = false;
  private interrupted = false;
  private pending = new Map<string, Pending>();
  private pid?: number;
  stderr = '';
  exit!: Promise<void>;
  constructor(
    readonly s: Session,
    private options: Record<string, unknown>,
    private changed: () => void,
    private onExit: (reason: string, unexpected: boolean) => Promise<void>,
  ) {}
  private async *prompt() {
    while (!this.closed) {
      while (this.queue.length) yield this.queue.shift();
      if (this.closed) return;
      await new Promise<void>((r) => (this.wake = r));
    }
  }
  async start() {
    const { query } = await sdk();
    if (this.closed) throw new Error('Arranque de Claude cancelado.');
    const s = this.s;
    this.query = query({
      prompt: this.prompt(),
      options: {
        ...this.options,
        abortController: this.controller,
        stderr: (d: string) => {
          this.stderr = (this.stderr + d).slice(-6000);
        },
        canUseTool: (tool: string, input: any, opts: any) => this.ask(tool, input, opts),
      },
    });
    const init = await this.query.initializationResult();
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
    info.models = (init.models ?? []).map((m: any) => ({
      value: m.value,
      displayName: m.displayName,
      description: m.description,
      supportedEffortLevels: m.supportedEffortLevels,
    }));
    info.commands = (init.commands ?? []).map((c: any) => ({
      name: c.name,
      description: c.description ?? '',
      argumentHint: c.argumentHint,
      builtin: c.builtin,
    }));
    info.agents = (init.agents ?? []).map((a: any) => a.name ?? String(a));
    info.outputStyle = init.output_style;
    info.outputStyles = init.available_output_styles ?? [];
    info.account = init.account;
    s.account = init.account?.email
      ? `${init.account.email} · ${init.account.subscriptionType ?? 'suscripción'}`
      : undefined;
    this.exit = this.consume();
    this.exit.catch(() => {});
    return init;
  }
  private async consume() {
    const s = this.s;
    let unexpected = true,
      reason = 'Claude Code terminó.';
    try {
      for await (const m of this.query) {
        // A turn stopped by the user ends in an execution error; the note already explains it.
        const stopped =
          m.type === 'result' && this.interrupted && m.subtype === 'error_during_execution';
        if (m.type === 'result') this.interrupted = false;
        applyClaudeMessage(s, stopped ? { ...m, subtype: 'success', is_error: false } : m);
        if (m.type === 'result') void this.refreshContext();
        this.changed();
      }
      unexpected = !this.closed;
    } catch (e) {
      reason = (e as Error).message;
      const tail = this.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
      if (tail && !reason.includes(tail)) reason += ` ${tail}`;
      unexpected = !this.closed;
    } finally {
      for (const [id, p] of this.pending) {
        p.resolve({ behavior: 'deny', message: 'La sesión se cerró.' });
        this.pending.delete(id);
      }
      await this.onExit(reason, unexpected);
    }
  }
  private ask(tool: string, input: any, opts: any) {
    if (
      (tool === 'mcp__agent_desk__coordinate' && coordinationInput.safeParse(input).success) ||
      (tool === 'mcp__agent_desk__browser' && browserInput.safeParse(input).success)
    )
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    const s = this.s;
    return new Promise<unknown>((resolve) => {
      const id = randomUUID();
      const approval: Approval = {
        id,
        method: 'claude/permission',
        params: {},
        tool,
        input,
        suggestions: opts?.suggestions,
        title: opts?.title,
        reason: opts?.decisionReason,
        blockedPath: opts?.blockedPath,
      };
      s.approvals.push(approval);
      s.status = 'waiting';
      s.activity = undefined;
      this.changed();
      this.pending.set(id, { resolve, signal: opts?.signal });
      opts?.signal?.addEventListener?.('abort', () => {
        if (!this.pending.delete(id)) return;
        s.approvals = s.approvals.filter((a) => a.id !== id);
        if (!s.approvals.length && s.status === 'waiting') s.status = 'working';
        this.changed();
        resolve({ behavior: 'deny', message: 'Solicitud cancelada.', interrupt: true });
      });
    });
  }
  approve(
    id: string | number,
    decision: 'accept' | 'always' | 'decline',
    answers?: Record<string, string>,
    message?: string,
  ) {
    const s = this.s;
    const a = s.approvals.find((a) => a.id === id);
    const p = this.pending.get(String(id));
    if (!a || !p) throw new Error('La solicitud ya no está pendiente.');
    const result = permissionResult(a, decision, answers, message);
    this.pending.delete(String(id));
    s.approvals = s.approvals.filter((x) => x.id !== id);
    s.status = s.approvals.length ? 'waiting' : 'working';
    p.resolve(result);
  }
  async subscriptionUsage() {
    const method = this.query?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof method !== 'function')
      throw new Error('Esta versión de Claude Code no permite consultar la cuota desde el chat.');
    return method.call(this.query, { skipBehaviors: true });
  }
  send(text: string, images: PreparedImage[] = []) {
    const s = this.s;
    s.messages.push({
      id: `u-${randomUUID()}`,
      role: 'user',
      text,
      attachments: images.map((i) => i.attachment),
      at: Date.now(),
    });
    s.status = 'working';
    s.error = undefined;
    s.activity = 'Enviando…';
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: images.length ? claudeImageContent(text, images) : text },
      parent_tool_use_id: null,
    });
    this.wake?.();
  }
  async interrupt() {
    const busy = this.s.status === 'working' || this.s.status === 'waiting';
    // Set before awaiting: the turn's result can arrive while the interrupt is in flight.
    if (busy) this.interrupted = true;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.resolve({
        behavior: 'deny',
        message: 'El usuario ha interrumpido el turno.',
        interrupt: true,
      });
    }
    this.s.approvals = [];
    await this.query?.interrupt();
    this.s.activity = undefined;
    settle(this.s);
    if (busy) note(this.s, 'info', 'Interrumpido · Escribe qué debe hacer en su lugar.');
    if (!this.s.approvals.length) this.s.status = 'ready';
  }
  async setModel(model: string) {
    await this.query?.setModel(model === 'default' ? undefined : model);
    if (this.s.info) this.s.info.model = model;
  }
  async setPermissionMode(mode: string) {
    if (!this.query)
      throw new Error('Claude está arrancando. Vuelve a seleccionar el modo cuando esté listo.');
    await this.query.setPermissionMode(mode);
    if (this.s.info) this.s.info.permissionMode = mode as any;
  }
  async setEffort(effort?: string) {
    await this.query?.applyFlagSettings({ effortLevel: effort ?? null });
    if (this.s.info) this.s.info.effort = (effort as any) ?? null;
  }
  async setThinking(enabled: boolean, budget?: number, display?: string) {
    await this.query?.setMaxThinkingTokens(enabled ? (budget ?? null) : 0, display ?? null);
  }
  async refreshContext() {
    try {
      const usage = await this.query?.getContextUsage();
      const st = (this.s.stats ??= {
        cost: 0,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
      });
      st.contextTokens = usage?.total_tokens;
      st.contextMax = usage?.raw_max_tokens;
      st.contextPercent = usage?.percentage;
      this.changed();
      return usage;
    } catch {
      return undefined;
    }
  }
  async contextReport() {
    const usage: any = await this.refreshContext();
    if (!usage) throw new Error('No se pudo consultar el contexto.');
    const lines = (usage.categories ?? [])
      .filter((c: any) => c.tokens > 0)
      .map((c: any) => `${c.name}: ${Math.round(c.tokens / 1000)}k`);
    note(
      this.s,
      'command',
      `Contexto: ${Math.round((usage.total_tokens ?? 0) / 1000)}k de ${Math.round((usage.raw_max_tokens ?? 0) / 1000)}k tokens (${usage.percentage ?? 0}%)\n${lines.join('\n')}`,
    );
  }
  async mcpStatus() {
    const servers = await this.query?.mcpServerStatus();
    if (this.s.info && Array.isArray(servers))
      this.s.info.mcpServers = servers.map((x: any) => ({
        name: x.name,
        status: x.status,
        tools: x.tools?.length,
        error: x.error,
      }));
    return servers;
  }
  async stop() {
    this.closed = true;
    this.controller.abort();
    this.wake?.();
    try {
      for (const [id, p] of this.pending) {
        this.pending.delete(id);
        p.resolve({ behavior: 'deny', message: 'La sesión se está cerrando.', interrupt: true });
      }
      this.query?.close();
    } catch {
      /* already closed */
    }
    if (!this.exit) return; // The aborted initialization is awaited by Manager's startup operation.
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.exit,
        new Promise<void>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error('No se ha confirmado la salida de Claude. La carpeta sigue bloqueada.'),
              ),
            8000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
  get processId() {
    return this.pid;
  }
}
