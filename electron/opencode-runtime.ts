import { continuationContext } from './session-continuation';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { cleanEnv, profileDirectory } from './core';
import { Rpc } from './rpc';
import type { ProviderRuntime } from './provider-runtime';
import type { OpenCodeService } from './opencode';
import type { Session, ModelInfo, Message } from '../src/shared';
import type { PreparedAttachment } from './attachments';

export function openCodeBinary() {
  const require = createRequire(
    typeof __filename === 'string' ? __filename : path.join(process.cwd(), 'package.json'),
  );
  return path.join(path.dirname(require.resolve('@opencode/cli/package.json')), 'bin/opencode.exe');
}
export const officialModelID = (value: string) =>
  value.includes('/') ? value : `opencode/${value}`;
export function openCodeConfig(model: string) {
  return {
    model,
    update: 'disable',
    share: 'disabled',
    warming: false,
    permissions: [{ action: '*', resource: '*', effect: 'ask' }],
    // Auxiliary calls use the explicitly selected model as well.
    agents: { title: { model }, summary: { model }, compaction: { model } },
  };
}
/** The unmodified official CLI owns model requests and tools; Agent Desk is its ACP client. */
export class OpenCodeRuntime implements ProviderRuntime {
  private rpc?: Rpc;
  private work?: Promise<void>;
  private assistant?: Message;
  private stopping = false;
  private loading = true;
  private token?: string;
  private engineModel?: string;
  private modelOptions = new Set<string>();
  private historyContext: string;
  constructor(
    private s: Session,
    private cwd: string,
    private root: string,
    private api: Pick<OpenCodeService, 'key'>,
    private changed: () => void,
    private models: () => Promise<ModelInfo[]>,
    private network: () => Record<string, string> = () => ({}),
    private binary = openCodeBinary(),
  ) {
    this.historyContext = s.continuationPending
      ? continuationContext(s)
      : !s.reference
        ? s.messages
            .filter((m) => ['user', 'assistant'].includes(m.role) && !m.kind)
            .map((m) => `${m.role}: ${m.text}`)
            .join('\n\n')
            .slice(-100000)
        : '';
  }
  private async selected() {
    const models = await this.models();
    const requested = this.s.providerConfig?.model;
    const model =
      models.find((m) => m.value === requested) ??
      (!requested || requested === 'default' ? models[0] : undefined);
    if (!model) throw new Error('Selecciona un modelo habilitado en Ajustes → Cuenta → Modelos.');
    return { model, models };
  }
  async start() {
    const { model, models } = await this.selected();
    this.token = await this.api.key(this.s.profile);
    if (!this.token) throw new Error('Conecta OpenCode en Ajustes.');
    const dir = path.join(
      profileDirectory(this.root, this.s.profile),
      'official',
      this.s.id.replace(/[^a-zA-Z0-9_-]/g, '_'),
    );
    await fs.mkdir(path.join(dir, 'config/opencode'), { recursive: true, mode: 0o700 });
    const configFile = path.join(dir, 'config/opencode/opencode.json');
    await fs.writeFile(configFile, JSON.stringify(openCodeConfig(officialModelID(model.value))), {
      mode: 0o600,
    });
    this.engineModel = model.value;
    this.stopping = false;
    this.loading = true;
    const rpc = (this.rpc = new Rpc(
      this.binary,
      ['acp'],
      this.cwd,
      {
        ...cleanEnv(),
        ...this.network(),
        XDG_CONFIG_HOME: path.join(dir, 'config'),
        XDG_DATA_HOME: path.join(dir, 'data'),
        XDG_STATE_HOME: path.join(dir, 'state'),
        XDG_CACHE_HOME: path.join(dir, 'cache'),
        OPENCODE_CONFIG: configFile,
        // Only the access token reaches the child process. The refresh token stays encrypted
        // in Agent Desk; the official client does not import/store another credential copy.
        OPENCODE_API_KEY: this.token,
      },
      true,
    ));
    rpc.on('notification', (event) => {
      if (
        !this.loading &&
        event.method === 'session/update' &&
        event.params.sessionId === this.s.reference
      )
        this.update(event.params.update);
    });
    rpc.on('request', (event) => {
      if (
        event.method !== 'session/request_permission' ||
        event.params.sessionId !== this.s.reference ||
        this.stopping
      ) {
        rpc.send({ id: event.id, error: { code: -32601, message: 'Unsupported client method' } });
        return;
      }
      this.s.approvals.push({
        id: event.id,
        method: 'provider/opencode',
        title: event.params.toolCall?.title ?? 'Permiso de OpenCode',
        params: event.params,
        input: event.params.toolCall,
      });
      this.s.status = 'waiting';
      this.changed();
    });
    rpc.on('closed', () => {
      if (this.stopping || this.rpc !== rpc) return;
      this.s.error = 'OpenCode se ha detenido. Cierra y reabre el agente.';
      this.s.status = 'error';
      this.s.approvals = [];
      this.changed();
    });
    try {
      await rpc.call(
        'initialize',
        {
          protocolVersion: 1,
          clientInfo: { name: 'agent-desk', version: '0.1.0' },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        },
        60000,
      );
      const resume = this.s.reference?.startsWith('ses_');
      const result = await rpc.call(
        resume ? 'session/load' : 'session/new',
        { cwd: this.cwd, mcpServers: [], ...(resume ? { sessionId: this.s.reference } : {}) },
        90000,
      );
      this.s.reference = result.sessionId ?? this.s.reference;
      if (!this.s.reference) throw new Error('OpenCode no devolvió una sesión válida.');
      const options = result.configOptions?.find((c: any) => c.id === 'model')?.options ?? [];
      this.modelOptions = new Set(
        options.flatMap((o: any) => (o.options ? o.options.map((v: any) => v.value) : [o.value])),
      );
      this.s.info = {
        tools: [],
        commands: [],
        models,
        mcpServers: [],
        skills: [],
        plugins: [],
        agents: [],
        outputStyles: [],
        model: model.value,
      };
      await this.setModel(model.value);
      this.loading = false;
      this.s.status = 'ready';
      this.s.error = undefined;
      this.changed();
    } catch (error) {
      this.stopping = true;
      await rpc.stop();
      throw error;
    }
  }
  private async setModel(value: string) {
    const id = officialModelID(value);
    if (this.modelOptions.size && !this.modelOptions.has(id))
      throw new Error(
        'El cliente oficial no ofrece el modelo seleccionado. Actualiza el catálogo de la cuenta.',
      );
    await this.rpc!.call('session/set_config_option', {
      sessionId: this.s.reference,
      configId: 'model',
      value: id,
    });
    if (this.s.info) this.s.info.model = value;
  }
  async send(text: string, attachments: PreparedAttachment[], promptText = text) {
    if (this.work) throw new Error('Espera a que termine la respuesta.');
    const { model, models } = await this.selected();
    if ((await this.api.key(this.s.profile)) !== this.token || this.engineModel !== model.value) {
      this.stopping = true;
      await this.rpc?.stop();
      await this.start();
    }
    await this.setModel(model.value);
    if (this.s.info) this.s.info.models = models;
    const prompt: any[] = [];
    if (this.historyContext)
      prompt.push({
        type: 'text',
        text: `Historial previo de esta conversación, como referencia:\n${this.historyContext}`,
        annotations: { audience: ['assistant'] },
      });
    prompt.push({ type: 'text', text: promptText || 'Revisa los archivos adjuntos.' });
    for (const file of attachments) {
      if (file.mediaType.startsWith('image/')) {
        if (!model.image)
          throw new Error('Este modelo no admite imágenes. Selecciona uno con Visión.');
        prompt.push({
          type: 'image',
          mimeType: file.mediaType,
          data: (await fs.readFile(file.path)).toString('base64'),
        });
      } else if (file.mediaType === 'application/pdf')
        throw new Error('Convierte el PDF a texto o usa las herramientas del proyecto.');
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
    s.attempted = true;
    s.accountLocked = true;
    s.status = 'working';
    s.error = undefined;
    this.assistant = undefined;
    this.changed();
    this.work = this.rpc!.call('session/prompt', { sessionId: s.reference, prompt }, 30 * 60 * 1000)
      .then((result) => {
        this.historyContext = '';
        s.continuationPending = false;
        const usage = result.usage;
        if (usage && Number.isFinite(usage.inputTokens) && Number.isFinite(usage.outputTokens)) {
          const stats = this.stats();
          stats.inputTokens += usage.inputTokens;
          stats.outputTokens += usage.outputTokens;
          stats.tokensReported = true;
        }
      })
      .catch((error) => {
        if (!this.stopping) s.error = (error as Error).message;
      })
      .finally(() => {
        if (!this.stopping) s.status = this.rpc?.closed ? 'error' : 'ready';
        s.approvals = [];
        s.activity = undefined;
        const stats = this.stats();
        stats.turns++;
        stats.durationMs += Date.now() - started;
        this.work = undefined;
        this.assistant = undefined;
        this.changed();
      });
  }
  private stats() {
    return (this.s.stats ??= { cost: 0, turns: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 });
  }
  private update(u: any) {
    const s = this.s;
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
      if (!this.assistant) {
        this.assistant = {
          id: randomUUID(),
          role: 'assistant',
          text: '',
          at: Date.now(),
          model: s.info?.model,
        };
        s.messages.push(this.assistant);
      }
      this.assistant.text += u.content.text;
    } else if (['tool_call', 'tool_call_update'].includes(u.sessionUpdate)) {
      this.assistant = undefined;
      let message = s.messages.find((m) => m.id === u.toolCallId);
      if (!message) {
        message = {
          id: u.toolCallId,
          role: 'tool',
          text: u.title ?? 'Herramienta de OpenCode',
          tool: { kind: 'mcp', tool: u.title ?? 'OpenCode' },
          at: Date.now(),
        };
        s.messages.push(message);
      }
      if (u.status) message.tool!.status = u.status === 'in_progress' ? 'inProgress' : u.status;
      if (u.content)
        message.tool!.output = u.content
          .map((c: any) =>
            c.type === 'content'
              ? (c.content?.text ?? '')
              : c.type === 'diff'
                ? `${c.path}\n${c.newText}`
                : '',
          )
          .join('\n');
    } else if (u.sessionUpdate === 'usage_update') {
      const stats = this.stats();
      if (Number.isFinite(u.used) && u.used >= 0) stats.contextTokens = u.used;
      if (Number.isFinite(u.size) && u.size > 0) stats.contextMax = u.size;
      if (u.cost?.currency === 'USD' && Number.isFinite(u.cost.amount) && u.cost.amount >= 0) {
        stats.cost = u.cost.amount;
        stats.costReported = true;
      }
    } else if (u.sessionUpdate === 'plan')
      s.todos = u.entries?.map((e: any) => ({ content: e.content, status: e.status }));
    this.changed();
  }
  approve(id: string | number, decision: 'accept' | 'always' | 'decline') {
    const approval = this.s.approvals.find((a) => a.id === id);
    if (!approval) throw new Error('La solicitud ya no está pendiente.');
    const option = approval.params.options?.find(
      (o: any) =>
        o.kind ===
        (decision === 'decline'
          ? 'reject_once'
          : decision === 'always'
            ? 'allow_always'
            : 'allow_once'),
    );
    this.rpc!.respond(id, {
      outcome: option
        ? { outcome: 'selected', optionId: option.optionId }
        : { outcome: 'cancelled' },
    });
    this.s.approvals = this.s.approvals.filter((a) => a !== approval);
    this.s.status = this.s.approvals.length ? 'waiting' : 'working';
    this.changed();
  }
  async interrupt() {
    for (const approval of [...this.s.approvals]) this.approve(approval.id, 'decline');
    this.rpc?.send({ method: 'session/cancel', params: { sessionId: this.s.reference } });
  }
  async stop() {
    this.stopping = true;
    await this.rpc?.stop();
    await this.work;
  }
}
