import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { cleanEnv } from './core';
import { reapGroup } from './processes';
import type { AccountState, ModelInfo, Profile, Session, Message } from '../src/shared';
import type { PreparedAttachment } from './attachments';
import type { ProviderRuntime } from './provider-runtime';
const exec = promisify(execFile);
export const isAntigravity = (binary?: string) =>
  !!binary && /^agy(?:\.exe)?$/.test(path.basename(binary));
const linkFile = (root: string) => path.join(root, 'antigravity-link.json');
const permissionDenied = /permission|soft.denied|approval|denied/i;
const permissionNotice =
  'Gemini necesita permiso para una herramienta. Abre la terminal de Antigravity, escribe «continúa» y revisa allí la solicitud de permiso.';
export function antigravityEnv(network: Record<string, string> = {}) {
  return {
    ...cleanEnv(),
    ...network,
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
    GEMINI_API_KEY: '',
    GOOGLE_API_KEY: '',
  };
}
async function command(
  binary: string,
  args: string[],
  network: Record<string, string>,
  signal?: AbortSignal,
) {
  try {
    return (
      await exec(binary, args, {
        env: antigravityEnv(network),
        timeout: 30000,
        maxBuffer: 2_000_000,
        signal,
      })
    ).stdout;
  } catch {
    throw new Error(
      'Antigravity no pudo verificar el acceso. Abre su terminal de acceso en Ajustes y completa la conexión con Google.',
    );
  }
}
export async function antigravityModels(
  binary: string,
  network: Record<string, string>,
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  const output = await command(binary, ['models'], network, signal);
  const models = output.split(/\r?\n/).flatMap((line) => {
    const [value, ...name] = line.trim().split(/\s+/);
    return /^gemini-[\w.-]+$/.test(value)
      ? [
          {
            value,
            displayName: name.join(' ') || value,
            description: 'Gemini mediante tu cuenta de Antigravity',
            tools: true,
            image: false,
            categories: ['programming', 'general'],
          },
        ]
      : [];
  });
  if (!models.length) throw new Error('Antigravity no devolvió modelos Gemini disponibles.');
  return models;
}
async function verify(binary: string, network: Record<string, string>) {
  const result = JSON.parse(
    await command(
      binary,
      ['--print', '/usage', '--output-format', 'json', '--print-timeout', '20s'],
      network,
    ),
  );
  if (result.status !== 'SUCCESS' || result.command?.name !== 'usage')
    throw new Error('Completa el acceso con Google en la terminal de Antigravity.');
}
export async function linkedAntigravity(root: string): Promise<Profile | undefined> {
  try {
    return JSON.parse(await fs.readFile(linkFile(root), 'utf8')).profile;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
}
export async function connectAntigravity(
  root: string,
  profile: Profile,
  binary: string,
  network: Record<string, string>,
) {
  const linked = await linkedAntigravity(root);
  if (linked && linked !== profile)
    throw new Error(
      'Antigravity ya está vinculado a otra cuenta de Agent Desk. Desvincúlala primero.',
    );
  await verify(binary, network);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(linkFile(root), JSON.stringify({ profile }), { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if (
      (e as NodeJS.ErrnoException).code !== 'EEXIST' ||
      (await linkedAntigravity(root)) !== profile
    )
      throw new Error('Antigravity ya está vinculado a otra cuenta.');
  }
}
export async function antigravityAccount(
  root: string,
  profile: Profile,
  binary: string,
  network: Record<string, string>,
): Promise<Partial<AccountState>> {
  if ((await linkedAntigravity(root)) !== profile) return { status: 'signedOut' };
  await verify(binary, network);
  return {
    status: 'signedIn',
    label: 'Google · sesión de Antigravity',
    plan: 'Acceso Google mediante Antigravity CLI',
  };
}
export async function disconnectAntigravity(root: string, profile: Profile) {
  if ((await linkedAntigravity(root)) === profile) await fs.rm(linkFile(root), { force: true });
}

/** Native chat uses the public stream-json protocol, retaining the CLI's permission policy. */
export class AntigravityRuntime implements ProviderRuntime {
  private child?: ChildProcessWithoutNullStreams;
  private work?: Promise<void>;
  private cancelled = false;
  constructor(
    private s: Session,
    private binary: string,
    private cwd: string,
    private network: Record<string, string>,
    private changed: () => void,
  ) {}
  async start() {
    const s = this.s;
    if (s.attempted && s.reference && !s.reference.startsWith('agy:'))
      throw new Error(
        'Este chat pertenece a Gemini CLI. Crea un chat nuevo para Antigravity; el historial anterior se conserva.',
      );
    const models = await antigravityModels(this.binary, this.network);
    const model = s.providerConfig?.model;
    if (model && model !== 'default' && !models.some((m) => m.value === model))
      throw new Error('Selecciona un modelo Gemini disponible en Antigravity.');
    s.providerConfig = { model: model && model !== 'default' ? model : models[0].value };
    s.info = {
      tools: [],
      commands: [],
      models,
      mcpServers: [],
      skills: [],
      plugins: [],
      agents: [],
      outputStyles: [],
      model: s.providerConfig.model,
    };
    s.notice =
      'El chat de Gemini solo ejecuta herramientas ya autorizadas por Antigravity. Para programar con solicitudes de permiso, abre la terminal integrada y continúa allí.';
    s.status = 'ready';
    this.changed();
  }
  async send(text: string, attachments: PreparedAttachment[]) {
    if (this.work) throw new Error('Espera a que termine la respuesta.');
    const s = this.s;
    // The public streaming protocol accepts text blocks only. Never pretend images were sent.
    if (attachments.length)
      throw new Error(
        'El chat de Antigravity admite texto. Para archivos del proyecto, indica su ruta; para adjuntos usa otro proveedor.',
      );
    this.cancelled = false;
    const model =
      s.providerConfig?.model === 'default' ? s.info?.models[0]?.value : s.providerConfig?.model;
    if (!model || !s.info?.models.some((m) => m.value === model))
      throw new Error('Selecciona un modelo Gemini disponible.');
    const args = [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--model',
      model,
      '--print-timeout',
      '30m',
    ];
    if (s.reference?.startsWith('agy:')) args.push('--conversation', s.reference.slice(4));
    const child = (this.child = spawn(this.binary, args, {
      cwd: this.cwd,
      env: antigravityEnv(this.network),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    }));
    const started = Date.now(),
      turnId = randomUUID();
    const turnTools: Message[] = [];
    let denied = false;
    s.messages.push({ id: randomUUID(), role: 'user', text, at: started });
    s.accountLocked = true;
    s.attempted = true;
    s.status = 'working';
    s.error = undefined;
    let assistant: Message | undefined,
      resultSeen = false,
      parseError = false;
    const ensureAssistant = () => {
      if (!assistant) {
        assistant = { id: randomUUID(), role: 'assistant', text: '', at: Date.now(), model };
        s.messages.push(assistant);
      }
      return assistant;
    };
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (this.cancelled) return;
      try {
        const event = JSON.parse(line);
        if (event.event === 'init' && typeof event.conversation_id === 'string')
          s.reference = 'agy:' + event.conversation_id;
        if (event.event === 'step_update') {
          const step = event.step_update;
          if (step.step_type === 'agent_response' && typeof step.text_delta === 'string')
            ensureAssistant().text += step.text_delta;
          if (step.step_type === 'tool') {
            const id = 'agy-tool:' + turnId + ':' + step.step_index;
            let message = s.messages.find((m) => m.id === id);
            if (!message) {
              message = {
                id,
                role: 'tool',
                text: step.tool_name ?? 'Herramienta',
                at: Date.now(),
                tool: { kind: 'mcp', tool: step.tool_name },
              };
              s.messages.push(message);
              turnTools.push(message);
            }
            const tool = message.tool!;
            const info = step.tool_info;
            const failure = info?.error;
            tool.tool = step.tool_name ?? info?.name ?? tool.tool;
            if (typeof info?.parameters?.CommandLine === 'string') {
              tool.kind = 'command';
              tool.command = info.parameters.CommandLine;
            }
            if (Number.isFinite(step.duration_seconds))
              tool.durationMs = step.duration_seconds * 1000;
            if (failure) {
              const detail =
                typeof failure === 'string' ? failure : (failure.message ?? failure.type);
              const needsPermission = permissionDenied.test(String(detail));
              tool.status = needsPermission ? 'declined' : 'failed';
              tool.output = String(detail ?? 'La herramienta falló.').slice(0, 40000);
              if (needsPermission) {
                denied = true;
                s.notice = permissionNotice;
              }
            } else if (!['failed', 'declined'].includes(tool.status ?? '')) {
              tool.status =
                step.state === 'DONE'
                  ? 'completed'
                  : ['ERROR', 'FAILED', 'CANCELED', 'CANCELLED'].includes(step.state)
                    ? 'failed'
                    : 'inProgress';
            }
            if (info && !failure)
              tool.output = (
                typeof info.output === 'string' ? info.output : JSON.stringify(info)
              ).slice(0, 40000);
          }
        }
        if (event.event === 'result') {
          resultSeen = true;
          const result = event.result;
          if (typeof result.conversation_id === 'string' && result.conversation_id)
            s.reference = 'agy:' + result.conversation_id;
          if (typeof result.response === 'string' && result.response)
            ensureAssistant().text = result.response;
          if (result.status !== 'SUCCESS')
            s.error = String(result.error ?? 'Antigravity no completó la respuesta.');
          const usage = result.usage;
          const stats = (s.stats ??= {
            cost: 0,
            turns: 0,
            inputTokens: 0,
            outputTokens: 0,
            durationMs: 0,
          });
          stats.turns++;
          stats.durationMs += Date.now() - started;
          // A resumed CLI result includes cumulative usage for that conversation.
          if (Number.isFinite(usage?.input_tokens) && Number.isFinite(usage?.output_tokens)) {
            stats.inputTokens = usage.input_tokens;
            stats.outputTokens = usage.output_tokens + (usage.thinking_tokens ?? 0);
            stats.tokensReported = true;
          }
          child.stdin.end();
        }
        this.changed();
      } catch {
        parseError = true;
      }
    });
    child.stderr.on('data', (data) => {
      // Never expose arbitrary diagnostics, which can include OAuth URLs or credentials.
      if (permissionDenied.test(String(data))) {
        denied = true;
        s.notice = permissionNotice;
        this.changed();
      }
    });
    child.stdin.on('error', () => {});
    this.work = new Promise<void>((resolve) => {
      child.on('error', () => {
        s.error = 'No se pudo iniciar Antigravity. Revisa el ejecutable en Ajustes.';
      });
      child.on('close', () => resolve());
    }).finally(async () => {
      if (child.pid) await reapGroup(child.pid);
      lines.close();
      this.child = undefined;
      this.work = undefined;
      if (!this.cancelled && !resultSeen)
        s.error = parseError
          ? 'Antigravity devolvió una respuesta no compatible.'
          : 'Antigravity cerró la conexión sin completar la respuesta.';
      for (const message of turnTools) {
        if (message.tool?.status === 'inProgress') {
          message.tool.status = 'failed';
          message.tool.output ??=
            'La ejecución terminó sin confirmar el resultado de esta herramienta.';
        }
      }
      if (denied && !this.cancelled)
        s.messages.push({
          id: randomUUID(),
          role: 'system',
          kind: 'warning',
          text: permissionNotice,
          at: Date.now(),
        });
      s.status = s.error ? 'error' : 'ready';
      this.changed();
    });
    void this.work.catch((error) => {
      s.error = (error as Error).message;
      s.status = 'error';
      this.changed();
    });
    child.stdin.write(JSON.stringify({ event: 'user', message: { content: text } }) + '\n');
    this.changed();
  }
  async interrupt() {
    this.cancelled = true;
    if (this.child?.pid) await reapGroup(this.child.pid);
    await this.work;
  }
  async stop() {
    await this.interrupt();
  }
  approve() {
    throw new Error('Autoriza las herramientas desde la terminal oficial de Antigravity.');
  }
}
