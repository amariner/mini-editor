import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpConnection, McpConnectionInput } from '../src/mcp-types';
import type { ProviderServices } from './openrouter';
import { mcpConnectionInputSchema } from './mcp-validation';
import {
  McpNeedsAuth,
  oauthCallback,
  oauthProvider,
  validateMcpUrl,
  type McpOAuthState,
} from './mcp-auth';

type SavedConnection = McpConnection & { secretFile?: string };
type Secrets = {
  env?: Record<string, string>;
  headers?: Record<string, string>;
  oauth?: McpOAuthState;
};
type Services = ProviderServices & { openExternal?: (url: string) => Promise<void> };
const timeout = 20_000;

function safeError(error: unknown) {
  if (
    error instanceof McpNeedsAuth ||
    error instanceof UnauthorizedError ||
    (error instanceof StreamableHTTPError && error.code === 401)
  )
    return {
      status: 'needs-auth' as const,
      error: 'El servidor requiere autenticación. Revisa las credenciales o inicia sesión.',
    };
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT')
    return {
      status: 'error' as const,
      error: 'No se encontró el ejecutable o el directorio del servidor MCP.',
    };
  if (
    Number(code) === -32001 ||
    (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
  )
    return {
      status: 'error' as const,
      error: 'La conexión se canceló o agotó el tiempo de espera.',
    };
  if (error instanceof StreamableHTTPError && error.code === 403)
    return {
      status: 'error' as const,
      error: 'El servidor denegó el acceso. Revisa los permisos de la conexión.',
    };
  return {
    status: 'error' as const,
    error:
      'No se pudo conectar con el servidor MCP. Revisa su configuración, credenciales y acceso de red.',
  };
}

/** App-owned MCP configurations. Renderer snapshots never contain credential values. */
export class McpConnections {
  private records = new Map<string, SavedConnection>();
  private directory: string;
  private file: string;
  private loadFailure = false;
  private closed = false;
  private operations = new Map<string, AbortController>();
  private active = new Set<Promise<unknown>>();
  private transports = new Set<Transport>();
  private refreshes = new Map<string, Promise<void>>();

  constructor(
    root: string,
    private services: Services = {},
    private changed: () => void = () => {},
    private networkEnvironment: () => Record<string, string> = () => ({}),
  ) {
    this.directory = path.join(root, 'mcp');
    this.file = path.join(this.directory, 'connections.json');
    if (!fs.existsSync(this.file)) return;
    try {
      if (fs.statSync(this.file).size > 4_000_000) throw new Error();
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (
        saved.version !== 1 ||
        !Array.isArray(saved.connections) ||
        saved.connections.length > 100
      )
        throw new Error();
      for (const row of saved.connections) {
        const input = mcpConnectionInputSchema.parse(row);
        if (
          !input.id ||
          this.records.has(input.id) ||
          !Number.isSafeInteger(row.revision) ||
          row.revision < 1
        )
          throw new Error();
        if (row.secretFile && !/^[a-f0-9-]{36}\.enc$/.test(row.secretFile)) throw new Error();
        this.records.set(input.id, {
          id: input.id,
          name: input.name,
          identity: input.identity,
          transport: input.transport,
          auth: input.auth ?? 'none',
          url: input.url,
          command: input.command,
          args: input.args,
          cwd: input.cwd,
          envKeys: Array.isArray(row.envKeys)
            ? row.envKeys.filter((key: unknown) => typeof key === 'string').slice(0, 100)
            : [],
          headerKeys: Array.isArray(row.headerKeys)
            ? row.headerKeys.filter((key: unknown) => typeof key === 'string').slice(0, 100)
            : [],
          revision: row.revision,
          status: 'unchecked',
          secretFile: row.secretFile,
        });
      }
    } catch {
      this.records.clear();
      this.loadFailure = true;
    }
  }

  snapshot(): McpConnection[] {
    return [...this.records.values()].map(({ secretFile: _secret, ...connection }) =>
      structuredClone(connection),
    );
  }

  private checkOpen() {
    if (this.closed) throw new Error('El gestor de conexiones está cerrado.');
    if (this.loadFailure)
      throw new Error('No se pudo leer el registro MCP. El archivo original se ha conservado.');
  }

  private record(id: string) {
    this.checkOpen();
    const record = this.records.get(id);
    if (!record) throw new Error('La conexión MCP ya no existe.');
    return record;
  }

  private publicRecord(id: string) {
    const { secretFile: _secret, ...connection } = this.record(id);
    return structuredClone(connection);
  }

  private atomic(file: string, contents: string | Buffer) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, contents, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  private commit(records: Map<string, SavedConnection>) {
    this.checkOpen();
    this.atomic(
      this.file,
      JSON.stringify({ version: 1, connections: [...records.values()] }, null, 2),
    );
    this.records = records;
    // A rendering notification must not roll back an already committed credentials transaction.
    try {
      this.changed();
    } catch {
      /* The next snapshot will expose the committed state. */
    }
  }

  private secrets(connection: SavedConnection): Secrets {
    if (!connection.secretFile) return {};
    try {
      if (!this.services.codec?.available()) throw new Error();
      const file = path.join(this.directory, connection.secretFile);
      if (fs.statSync(file).size > 1_000_000) throw new Error();
      const secrets: Secrets = JSON.parse(this.services.codec.decrypt(fs.readFileSync(file)));
      // Validate decrypted user-supplied fields before passing them to spawn/fetch.
      mcpConnectionInputSchema.parse({ ...connection, env: secrets.env, headers: secrets.headers });
      return secrets;
    } catch {
      throw new Error(
        'No se pudieron desbloquear las credenciales MCP. Revisa el almacén seguro del sistema.',
      );
    }
  }

  private replace(connection: SavedConnection, secrets?: Secrets) {
    const previous = this.records.get(connection.id);
    const next = { ...connection };
    let created: string | undefined;
    if (secrets !== undefined) {
      const populated =
        Object.keys(secrets.env ?? {}).length ||
        Object.keys(secrets.headers ?? {}).length ||
        secrets.oauth;
      if (populated) {
        if (!this.services.codec?.available())
          throw new Error('No se pueden guardar credenciales sin el almacén seguro del sistema.');
        next.secretFile = `${randomUUID()}.enc`;
        created = path.join(this.directory, next.secretFile);
        this.atomic(created, this.services.codec.encrypt(JSON.stringify(secrets)));
      } else delete next.secretFile;
    }
    try {
      this.commit(new Map(this.records).set(next.id, next));
    } catch (error) {
      if (created) fs.rmSync(created, { force: true });
      throw error;
    }
    if (previous?.secretFile && previous.secretFile !== next.secretFile)
      fs.rmSync(path.join(this.directory, previous.secretFile), { force: true });
    return next;
  }

  async save(raw: McpConnectionInput): Promise<McpConnection> {
    this.checkOpen();
    const result = mcpConnectionInputSchema.safeParse(raw);
    if (!result.success)
      throw new Error(result.error.issues[0]?.message ?? 'Configuración MCP no válida.');
    const input = result.data;
    const previous = input.id ? this.record(input.id) : undefined;
    if (!previous && this.records.size >= 100)
      throw new Error('Se ha alcanzado el máximo de 100 conexiones MCP.');
    const id = previous?.id ?? randomUUID();
    this.operations.get(id)?.abort();
    this.operations.delete(id);
    const authKind = input.transport === 'stdio' ? 'none' : (input.auth ?? 'none');
    const retain =
      (input.transport === 'stdio' && input.env === undefined) ||
      (authKind === 'headers' && input.headers === undefined) ||
      (authKind === 'oauth' && previous?.url === input.url && previous?.auth === 'oauth');
    const old = previous && retain ? this.secrets(previous) : {};
    const secrets: Secrets = {
      env:
        input.transport === 'stdio'
          ? input.env === undefined
            ? old.env
            : (input.env ?? undefined)
          : undefined,
      headers:
        input.transport === 'http' && authKind === 'headers'
          ? input.headers === undefined
            ? old.headers
            : (input.headers ?? undefined)
          : undefined,
      oauth:
        authKind === 'oauth' && previous?.url === input.url && previous?.auth === 'oauth'
          ? old.oauth
          : undefined,
    };
    this.replace(
      {
        id,
        name: input.name,
        identity: input.identity || undefined,
        transport: input.transport,
        auth: authKind,
        url: input.transport === 'http' ? input.url : undefined,
        command: input.transport === 'stdio' ? input.command : undefined,
        args: input.transport === 'stdio' ? (input.args ?? []) : undefined,
        cwd: input.transport === 'stdio' ? input.cwd || undefined : undefined,
        envKeys: Object.keys(secrets.env ?? {}).sort(),
        headerKeys: Object.keys(secrets.headers ?? {}).sort(),
        revision: (previous?.revision ?? 0) + 1,
        status: 'unchecked',
      },
      secrets,
    );
    return this.publicRecord(id);
  }

  async remove(id: string) {
    const previous = this.record(id);
    this.operations.get(id)?.abort();
    this.operations.delete(id);
    const records = new Map(this.records);
    records.delete(id);
    this.commit(records);
    if (previous.secretFile)
      fs.rmSync(path.join(this.directory, previous.secretFile), { force: true });
  }

  private update(id: string, patch: Partial<McpConnection>) {
    this.replace({ ...this.record(id), ...patch });
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.active.add(operation);
    void operation.finally(() => this.active.delete(operation)).catch(() => {});
    return operation;
  }

  private fetchFor(signal?: AbortSignal): typeof fetch {
    return async (resource, init = {}) => {
      // Native fetch accepts URL objects; Electron net.request needs strings for correct routing.
      // Normalize before crossing the configured transport boundary, including OAuth requests.
      const url = resource instanceof Request ? resource.url : String(resource);
      validateMcpUrl(new URL(url));
      const signals = [
        signal,
        init.signal,
        resource instanceof Request ? resource.signal : undefined,
        AbortSignal.timeout(timeout),
      ].filter((value): value is AbortSignal => !!value);
      const headers = new Headers(init.headers);
      const body = init.body instanceof URLSearchParams ? init.body.toString() : init.body;
      if (init.body instanceof URLSearchParams && !headers.has('Content-Type'))
        headers.set('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8');
      return (this.services.fetch ?? fetch)(url, {
        ...init,
        body,
        headers,
        signal: AbortSignal.any(signals),
        redirect: 'error',
      });
    };
  }

  private provider(
    connection: SavedConnection,
    secrets: Secrets,
    interactive?: { state: string; open: (url: string) => Promise<void> },
    signal?: AbortSignal,
  ) {
    const state = (secrets.oauth ??= {});
    let expectedFile = connection.secretFile;
    return oauthProvider(
      state,
      () => {
        signal?.throwIfAborted();
        const current = this.record(connection.id);
        if (
          current.secretFile !== expectedFile ||
          current.url !== connection.url ||
          current.auth !== 'oauth'
        )
          throw new DOMException('Configuration changed', 'AbortError');
        const next = this.replace({ ...current, revision: current.revision + 1 }, secrets);
        expectedFile = next.secretFile;
      },
      interactive,
    );
  }

  signature(ids: string[]) {
    return [...new Set(ids)]
      .map((id) => `${id}:${this.records.get(id)?.revision ?? 'missing'}`)
      .join('|');
  }

  resolve(ids: string[]) {
    return this.track(this.resolveConnections(ids));
  }

  private async resolveConnections(ids: string[]) {
    this.checkOpen();
    const resolved: Array<{
      connection: McpConnection;
      env: Record<string, string>;
      headers: Record<string, string>;
    }> = [];
    for (const id of [...new Set(ids)]) {
      let connection = this.record(id);
      let secrets = this.secrets(connection);
      if (connection.auth === 'oauth') {
        if (!secrets.oauth?.tokens) {
          this.update(id, { status: 'needs-auth' });
          throw new McpNeedsAuth();
        }
        if (
          secrets.oauth.expiresAt !== undefined &&
          secrets.oauth.expiresAt < Date.now() + 30_000
        ) {
          let refresh = this.refreshes.get(id);
          if (!refresh) {
            refresh = (async () => {
              if (!secrets.oauth?.tokens?.refresh_token) throw new McpNeedsAuth();
              await auth(this.provider(connection, secrets), {
                serverUrl: connection.url!,
                fetchFn: this.fetchFor(),
              });
            })();
            this.refreshes.set(id, refresh);
          }
          try {
            await refresh;
          } catch (error) {
            const failure = safeError(error);
            if (this.records.has(id) && !this.closed) this.update(id, failure);
            throw failure.status === 'needs-auth' ? new McpNeedsAuth() : new Error(failure.error);
          } finally {
            if (this.refreshes.get(id) === refresh) this.refreshes.delete(id);
          }
          connection = this.record(id);
          secrets = this.secrets(connection);
        }
      }
      resolved.push({
        connection: this.publicRecord(id),
        env: { ...(secrets.env ?? {}) },
        headers:
          connection.auth === 'oauth' && secrets.oauth?.tokens
            ? { Authorization: `Bearer ${secrets.oauth.tokens.access_token}` }
            : { ...(secrets.headers ?? {}) },
      });
    }
    return resolved;
  }

  test(id: string): Promise<McpConnection> {
    return this.track(this.testConnection(id));
  }

  private async testConnection(id: string): Promise<McpConnection> {
    this.record(id);
    this.operations.get(id)?.abort();
    const controller = new AbortController();
    this.operations.set(id, controller);
    const timer = setTimeout(() => controller.abort(), timeout);
    this.update(id, { status: 'checking', error: undefined, authenticating: false });
    const client = new Client({ name: 'Agent Desk', version: '1.0.0' });
    let transport: Transport | undefined;
    const abort = () => {
      void transport?.close().catch(() => {});
    };
    controller.signal.addEventListener('abort', abort, { once: true });
    try {
      const [resolved] = await this.resolveConnections([id]);
      controller.signal.throwIfAborted();
      const connection = this.record(id);
      const secrets = this.secrets(connection);
      transport =
        connection.transport === 'stdio'
          ? new StdioClientTransport({
              command: connection.command!,
              args: connection.args,
              cwd: connection.cwd,
              env: { ...this.networkEnvironment(), ...resolved.env },
              stderr: 'ignore',
              maxBufferSize: 4_000_000,
            })
          : new StreamableHTTPClientTransport(new URL(connection.url!), {
              requestInit: {
                headers: connection.auth === 'headers' ? resolved.headers : undefined,
              },
              authProvider:
                connection.auth === 'oauth'
                  ? this.provider(connection, secrets, undefined, controller.signal)
                  : undefined,
              fetch: this.fetchFor(controller.signal),
              reconnectionOptions: {
                maxRetries: 0,
                initialReconnectionDelay: 1000,
                maxReconnectionDelay: 1000,
                reconnectionDelayGrowFactor: 1,
              },
            });
      this.transports.add(transport);
      await client.connect(transport, { signal: controller.signal, timeout });
      const tools: NonNullable<McpConnection['tools']> = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      const hidden = [
        ...Object.values(secrets.env ?? {}),
        ...Object.values(secrets.headers ?? {}).flatMap((value) => [
          value,
          value.replace(/^(Bearer|Basic)\s+/i, ''),
        ]),
        secrets.oauth?.tokens?.access_token,
        secrets.oauth?.tokens?.refresh_token,
      ].filter((value): value is string => !!value);
      if (secrets.oauth?.client?.client_secret) hidden.push(secrets.oauth.client.client_secret);
      for (const value of Object.values(this.networkEnvironment())) {
        try {
          const url = new URL(value);
          if (url.username || url.password)
            hidden.push(value, decodeURIComponent(url.username), decodeURIComponent(url.password));
        } catch {
          /* Non-URL network settings contain no proxy userinfo. */
        }
      }
      const credentials = hidden.filter(Boolean);
      const redact = (value: string) =>
        credentials.reduce((text, secret) => text.split(secret).join('[credencial]'), value);
      if (client.getServerCapabilities()?.tools) {
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined, {
            signal: controller.signal,
            timeout,
          });
          for (const tool of page.tools)
            tools.push({
              name: redact(tool.name).slice(0, 256),
              description: tool.description ? redact(tool.description).slice(0, 2000) : undefined,
            });
          if (
            tools.length > 1000 ||
            cursors.size >= 100 ||
            (page.nextCursor && cursors.has(page.nextCursor))
          )
            throw new Error('Invalid pagination');
          cursor = page.nextCursor;
          if (cursor) cursors.add(cursor);
        } while (cursor);
      }
      if (this.operations.get(id) === controller && !this.closed)
        this.update(id, { status: 'connected', tools, checkedAt: Date.now(), error: undefined });
    } catch (error) {
      if (this.operations.get(id) === controller && !this.closed)
        this.update(id, { ...safeError(error), tools: undefined, checkedAt: Date.now() });
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abort);
      await client.close().catch(() => {});
      if (transport) {
        await transport.close().catch(() => {});
        this.transports.delete(transport);
      }
      if (this.operations.get(id) === controller) this.operations.delete(id);
    }
    return this.publicRecord(id);
  }

  authenticate(id: string): Promise<McpConnection> {
    return this.track(this.authenticateConnection(id));
  }

  private async authenticateConnection(id: string): Promise<McpConnection> {
    const connection = this.record(id);
    if (connection.transport !== 'http' || connection.auth !== 'oauth')
      throw new Error('Selecciona OAuth para iniciar sesión en esta conexión.');
    if (!this.services.openExternal)
      throw new Error('No se puede abrir el navegador de autenticación.');
    if (!this.services.codec?.available())
      throw new Error('El almacén seguro del sistema no está disponible.');
    this.operations.get(id)?.abort();
    const controller = new AbortController();
    this.operations.set(id, controller);
    const timer = setTimeout(() => controller.abort(), 180_000);
    this.update(id, { authenticating: true, status: 'needs-auth', error: undefined });
    let callback: Awaited<ReturnType<typeof oauthCallback>> | undefined;
    let successful = false;
    try {
      callback = await oauthCallback(controller.signal);
      const secrets = this.secrets(connection);
      // A new loopback port needs a new registration. Keep the previous credentials on disk until successful.
      secrets.oauth = { redirectUrl: callback.redirectUrl, discovery: secrets.oauth?.discovery };
      const provider = this.provider(
        connection,
        secrets,
        {
          state: callback.state,
          open: async (url) => {
            controller.signal.throwIfAborted();
            await this.services.openExternal!(url);
          },
        },
        controller.signal,
      );
      const fetchFn = this.fetchFor(controller.signal);
      const result = await auth(provider, { serverUrl: connection.url!, fetchFn });
      if (result === 'REDIRECT') {
        const authorizationCode = await callback.code;
        controller.signal.throwIfAborted();
        await auth(provider, { serverUrl: connection.url!, authorizationCode, fetchFn });
      }
      successful = true;
    } catch (error) {
      if (this.operations.get(id) === controller && !this.closed)
        this.update(id, { ...safeError(error), authenticating: false });
    } finally {
      clearTimeout(timer);
      await callback?.close();
      if (this.operations.get(id) === controller) {
        this.operations.delete(id);
        if (!this.closed) this.update(id, { authenticating: false });
      }
    }
    if (successful && !controller.signal.aborted && !this.closed) return this.test(id);
    return this.publicRecord(id);
  }

  cancelAuthentication(id: string) {
    if (!this.records.get(id)?.authenticating) return;
    this.operations.get(id)?.abort();
    this.operations.delete(id);
    this.update(id, { authenticating: false, status: 'needs-auth', error: undefined });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.operations.values()) controller.abort();
    this.operations.clear();
    await Promise.allSettled([...this.transports].map((transport) => transport.close()));
    await Promise.allSettled([...this.active]);
    this.transports.clear();
  }
}
