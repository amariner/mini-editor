import { continuationContext } from './session-continuation';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Rpc } from './rpc';
import { cleanEnv } from './core';
import type { Session, ModelInfo, Message, AccountState } from '../src/shared';
import type { PreparedAttachment } from './attachments';
import type { ProviderRuntime } from './provider-runtime';
import { googleClientUnavailable, isGoogleClientUnavailable } from '../src/google-access';
const accessFile = (dir: string) => path.join(dir, '.gemini/agent-desk-access.json');
async function recordAccess(dir: string, status: 'verified' | 'unsupported') {
  const file = accessFile(dir),
    temporary = file + '.' + randomUUID();
  try {
    await fs.writeFile(temporary, JSON.stringify({ status }), { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
class GeminiRpc extends Rpc {
  constructor(
    private accountDir: string,
    ...args: ConstructorParameters<typeof Rpc>
  ) {
    super(...args);
  }
  override async call(method: string, params: unknown = {}, timeout = 30000) {
    try {
      const result = await super.call(method, params, timeout);
      if (['authenticate', 'session/new', 'session/load'].includes(method))
        await recordAccess(this.accountDir, 'verified');
      return result;
    } catch (error) {
      if (isGoogleClientUnavailable((error as Error).message)) {
        await recordAccess(this.accountDir, 'unsupported');
        throw new Error(googleClientUnavailable);
      }
      throw error;
    }
  }
}
export async function geminiAccount(
  dir: string,
): Promise<Pick<AccountState, 'status' | 'label' | 'plan' | 'error'>> {
  try {
    let access: { status?: string } = {};
    try {
      access = JSON.parse(await fs.readFile(accessFile(dir), 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (access.status === 'unsupported')
      return { status: 'unknown', error: googleClientUnavailable };
    const settings = JSON.parse(await fs.readFile(path.join(dir, '.gemini/settings.json'), 'utf8'));
    const creds = JSON.parse(await fs.readFile(path.join(dir, '.gemini/oauth_creds.json'), 'utf8'));
    if (settings.security?.auth?.selectedType !== 'oauth-personal' || !creds.refresh_token)
      return { status: 'signedOut' };
    let label = 'Google';
    try {
      const accounts = JSON.parse(
        await fs.readFile(path.join(dir, '.gemini/google_accounts.json'), 'utf8'),
      );
      if (typeof accounts.active === 'string') label = accounts.active;
    } catch {}
    return access.status === 'verified'
      ? { status: 'signedIn', label, plan: 'Gemini CLI · acceso Google verificado' }
      : {
          status: 'unknown',
          label,
          error:
            'Hay credenciales de Google guardadas, pero su acceso no está verificado. Inicia sesión para comprobar si Google admite esta cuenta con Gemini CLI.',
        };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'signedOut' };
    throw new Error('No se pudo leer el acceso de Gemini. Vuelve a conectar la cuenta.');
  }
}
export async function geminiLogout(dir: string) {
  for (const name of ['oauth_creds.json', 'google_accounts.json', 'agent-desk-access.json'])
    await fs.rm(path.join(dir, '.gemini', name), { force: true });
}
export async function geminiRpc(
  binary: string,
  dir: string,
  network: Record<string, string> = {},
  cwd = dir,
  cloudProject?: string,
) {
  await fs.mkdir(path.join(dir, '.gemini'), { recursive: true, mode: 0o700 });
  // System overrides pin authentication to this profile even if a project supplies settings.
  const systemFile = path.join(dir, 'google-auth-settings.json');
  await fs.writeFile(
    systemFile,
    JSON.stringify({
      security: { auth: { selectedType: 'oauth-personal' } },
      telemetry: { enabled: false },
      advanced: { autoConfigureMemory: false },
    }),
    { mode: 0o600 },
  );
  return new GeminiRpc(
    dir,
    binary,
    ['--acp', '--approval-mode', 'default'],
    cwd,
    {
      ...cleanEnv(),
      ...network,
      GOOGLE_APPLICATION_CREDENTIALS: '',
      GEMINI_API_KEY: '',
      GOOGLE_API_KEY: '',
      GEMINI_CLI_HOME: dir,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemFile,
      GEMINI_TELEMETRY_ENABLED: 'false',
      ...(cloudProject ? { GOOGLE_CLOUD_PROJECT: cloudProject } : {}),
    },
    true,
  );
}
export async function initializeGemini(rpc: Rpc) {
  return rpc.call(
    'initialize',
    {
      protocolVersion: 1,
      clientInfo: { name: 'agent-desk', version: '0.1.0' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    },
    60000,
  );
}
export function geminiModels(result: any): ModelInfo[] {
  return (result.models?.availableModels ?? []).map((m: any) => ({
    value: m.modelId,
    displayName: m.name,
    description: m.description ?? '',
    isDefault: m.modelId === result.models.currentModelId,
    tools: true,
    image: true,
    categories: ['programming', 'general', 'vision'],
  }));
}
export class GeminiRuntime implements ProviderRuntime {
  private work?: Promise<void>;
  private assistant?: Message;
  private stopping = false;
  private loading = true;
  constructor(
    private s: Session,
    readonly rpc: Rpc,
    private cwd: string,
    private changed: () => void,
  ) {
    rpc.on('notification', (event) => {
      if (event.method === 'session/update' && event.params.sessionId === s.reference)
        this.update(event.params.update);
    });
    rpc.on('request', (event) => {
      if (event.method !== 'session/request_permission' || event.params.sessionId !== s.reference) {
        rpc.send({ id: event.id, error: { code: -32601, message: 'Unsupported client method' } });
        return;
      }
      s.approvals.push({
        id: event.id,
        method: 'provider/gemini',
        title: event.params.toolCall?.title ?? 'Permiso de Gemini',
        params: event.params,
        input: event.params.toolCall,
      });
      s.status = 'waiting';
      this.changed();
    });
    rpc.on('closed', () => {
      if (!this.stopping) {
        s.error = 'Gemini se ha detenido. Cierra y reabre el agente.';
        s.status = 'error';
        s.approvals = [];
        this.changed();
      }
    });
  }
  async start(mcpServers: any[] = []) {
    await initializeGemini(this.rpc);
    const resume = this.s.attempted && this.s.reference;
    // A failed resume must never silently discard an existing conversation.
    const result = await this.rpc.call(
      resume ? 'session/load' : 'session/new',
      { cwd: this.cwd, mcpServers, ...(resume ? { sessionId: this.s.reference } : {}) },
      90000,
    );
    if (!resume) this.s.reference = result.sessionId;
    this.s.info = {
      tools: [],
      commands: [],
      models: geminiModels(result),
      mcpServers: [],
      skills: [],
      plugins: [],
      agents: [],
      outputStyles: [],
      model: result.models?.currentModelId,
    };
    this.loading = false;
    this.s.status = 'ready';
    this.changed();
  }
  async send(text: string, attachments: PreparedAttachment[], promptText = text) {
    if (this.work) throw new Error('Espera a que termine la respuesta.');
    const model = this.s.providerConfig?.model;
    if (model && model !== 'default')
      await this.rpc.call('session/set_model', { sessionId: this.s.reference, modelId: model });
    const inherited = this.s.continuationPending ? continuationContext(this.s) : '';
    const prompt: any[] = [
      {
        type: 'text',
        text: [inherited, promptText || 'Revisa los archivos adjuntos.'].filter(Boolean).join('\n\n'),
      },
    ];
    for (const file of attachments) {
      if (file.mediaType.startsWith('image/'))
        prompt.push({
          type: 'image',
          mimeType: file.mediaType,
          data: (await fs.readFile(file.path)).toString('base64'),
        });
      else
        prompt.push({
          type: 'resource_link',
          uri: pathToFileURL(file.path).href,
          name: file.attachment.name,
          mimeType: file.mediaType,
        });
    }
    const s = this.s,
      started = Date.now();
    s.messages.push({
      id: randomUUID(),
      role: 'user',
      text,
      at: started,
      attachments: attachments.map((f) => f.attachment),
    });
    s.accountLocked = true;
    s.attempted = true;
    s.status = 'working';
    s.error = undefined;
    this.assistant = undefined;
    this.changed();
    this.work = this.rpc
      .call('session/prompt', { sessionId: s.reference, prompt }, 30 * 60 * 1000)
      .then(() => {
        this.s.continuationPending = false;
      })
      .catch((e) => {
        if (!this.stopping) s.error = (e as Error).message;
      })
      .finally(() => {
        if (!this.stopping) s.status = this.rpc.closed ? 'error' : 'ready';
        s.approvals = [];
        s.activity = undefined;
        const stats = (s.stats ??= {
          cost: 0,
          turns: 0,
          inputTokens: 0,
          outputTokens: 0,
          durationMs: 0,
        });
        stats.turns++;
        stats.durationMs += Date.now() - started;
        this.assistant = undefined;
        this.work = undefined;
        this.changed();
      });
  }
  private update(u: any) {
    if (this.loading) return;
    const s = this.s;
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
      if (!this.assistant) {
        this.assistant = {
          id: randomUUID(),
          role: 'assistant',
          text: '',
          at: Date.now(),
          model: s.providerConfig?.model ?? s.info?.model,
        };
        s.messages.push(this.assistant);
      }
      this.assistant.text += u.content.text;
    } else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
      this.assistant = undefined;
      let m = s.messages.find((m) => m.id === u.toolCallId);
      if (!m) {
        m = {
          id: u.toolCallId,
          role: 'tool',
          text: u.title ?? 'Herramienta de Gemini',
          tool: { kind: 'mcp', tool: u.title ?? 'Gemini' },
          at: Date.now(),
        };
        s.messages.push(m);
      }
      if (u.status) m.tool!.status = u.status === 'in_progress' ? 'inProgress' : u.status;
      if (u.content)
        m.tool!.output = u.content
          .map((c: any) =>
            c.type === 'content'
              ? (c.content?.text ?? '')
              : c.type === 'diff'
                ? `${c.path}\n${c.newText}`
                : '',
          )
          .join('\n');
    } else if (u.sessionUpdate === 'usage_update') {
      const stats = (s.stats ??= {
        cost: 0,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
      });
      if (Number.isFinite(u.used) && u.used >= 0) stats.contextTokens = u.used;
      if (Number.isFinite(u.size) && u.size > 0) stats.contextMax = u.size;
      if (u.cost?.currency === 'USD' && Number.isFinite(u.cost.amount)) {
        stats.cost = u.cost.amount;
        stats.costReported = true;
      }
    } else if (u.sessionUpdate === 'plan')
      s.todos = u.entries?.map((e: any) => ({ content: e.content, status: e.status }));
    this.changed();
  }
  approve(id: string | number, decision: 'accept' | 'always' | 'decline') {
    const a = this.s.approvals.find((a) => a.id === id);
    if (!a) throw new Error('La solicitud ya no está pendiente.');
    const option = a.params.options?.find(
      (o: any) =>
        o.kind ===
        (decision === 'decline'
          ? 'reject_once'
          : decision === 'always'
            ? 'allow_always'
            : 'allow_once'),
    );
    this.rpc.respond(id, {
      outcome: option
        ? { outcome: 'selected', optionId: option.optionId }
        : { outcome: 'cancelled' },
    });
    this.s.approvals = this.s.approvals.filter((a) => a !== a);
    this.s.status = this.s.approvals.length ? 'waiting' : 'working';
    this.changed();
  }
  async interrupt() {
    for (const a of [...this.s.approvals]) this.approve(a.id, 'decline');
    this.rpc.send({ method: 'session/cancel', params: { sessionId: this.s.reference } });
  }
  async stop() {
    this.stopping = true;
    await this.rpc.stop();
    await this.work;
  }
}
