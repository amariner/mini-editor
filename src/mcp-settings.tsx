import React, { useEffect, useState } from 'react';
import {
  Cable,
  Check,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import type { Action, Snapshot } from './shared';
import type { McpAuth, McpConnection, McpConnectionInput, McpTransport } from './mcp-types';
import { McpSelection } from './mcp-selection';
import './mcp-settings.css';

type SecretMode = 'preserve' | 'replace' | 'clear';
type SecretRow = { key: string; value: string };
type SecretDraft = { mode: SecretMode; rows: SecretRow[] };
const secrets = (keys?: string[]): SecretDraft => ({
  mode: keys?.length ? 'preserve' : 'replace',
  rows: [{ key: '', value: '' }],
});

function SecretFields({
  title,
  keys,
  value,
  onChange,
  disabled,
  header = false,
}: {
  title: string;
  keys: string[];
  value: SecretDraft;
  onChange: (draft: SecretDraft) => void;
  disabled: boolean;
  header?: boolean;
}) {
  return (
    <div className="mcp-secrets">
      <div className="mcp-section-title">
        <span>{title}</span>
      </div>
      {keys.length > 0 && (
        <>
          <p className="mcp-help">Guardadas: {keys.join(', ')}. Sus valores no se muestran.</p>
          <select
            aria-label={`${title}: valores guardados`}
            value={value.mode}
            disabled={disabled}
            onChange={(event) =>
              onChange({ mode: event.target.value as SecretMode, rows: [{ key: '', value: '' }] })
            }
          >
            <option value="preserve">Conservar los valores guardados</option>
            <option value="replace">Reemplazar todos los valores</option>
            <option value="clear">Eliminar todos los valores guardados</option>
          </select>
        </>
      )}
      {value.mode === 'replace' && (
        <>
          {value.rows.map((row, index) => (
            <div className="mcp-secret-row" key={index}>
              <input
                aria-label={`${title}: nombre ${index + 1}`}
                placeholder={header ? 'Authorization' : 'API_KEY'}
                value={row.key}
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
                onChange={(event) =>
                  onChange({
                    ...value,
                    rows: value.rows.map((item, at) =>
                      at === index ? { ...item, key: event.target.value } : item,
                    ),
                  })
                }
              />
              <input
                aria-label={`${title}: valor ${index + 1}`}
                type="password"
                placeholder={header ? 'Bearer …' : 'Valor'}
                autoComplete="new-password"
                value={row.value}
                disabled={disabled}
                onChange={(event) =>
                  onChange({
                    ...value,
                    rows: value.rows.map((item, at) =>
                      at === index ? { ...item, value: event.target.value } : item,
                    ),
                  })
                }
              />
              <button
                type="button"
                className="mcp-icon-button"
                aria-label={`Quitar ${title.toLowerCase()} ${index + 1}`}
                disabled={disabled}
                onClick={() =>
                  onChange({ ...value, rows: value.rows.filter((_, at) => at !== index) })
                }
              >
                <X size={14} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="mcp-text-button"
            disabled={disabled}
            onClick={() => onChange({ ...value, rows: [...value.rows, { key: '', value: '' }] })}
          >
            <Plus size={13} />
            {header ? 'Añadir cabecera' : 'Añadir variable'}
          </button>
        </>
      )}
    </div>
  );
}

function secretPayload(value: SecretDraft, label: string, header = false) {
  if (value.mode === 'preserve') return undefined;
  if (value.mode === 'clear') return null;
  const rows = value.rows.filter((row) => row.key.trim() || row.value);
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    const normalized = header ? key.toLowerCase() : key;
    if (!key) throw new Error(`Indica el nombre de cada ${label}.`);
    if (seen.has(normalized)) throw new Error(`El nombre «${key}» está repetido.`);
    seen.add(normalized);
  }
  return Object.fromEntries(rows.map((row) => [row.key.trim(), row.value]));
}

function ConnectionForm({
  connection,
  compatible,
  run,
  close,
}: {
  connection?: McpConnection;
  compatible: boolean;
  run: (action: Action) => Promise<any>;
  close: () => void;
}) {
  const [name, setName] = useState(connection?.name ?? '');
  const [identity, setIdentity] = useState(connection?.identity ?? '');
  const [transport, setTransport] = useState<McpTransport>(connection?.transport ?? 'http');
  const [url, setUrl] = useState(connection?.url ?? '');
  const [auth, setAuth] = useState<McpAuth>(connection?.auth ?? 'none');
  const [command, setCommand] = useState(connection?.command ?? '');
  const [args, setArgs] = useState((connection?.args ?? []).join('\n'));
  const [cwd, setCwd] = useState(connection?.cwd ?? '');
  const [headers, setHeaders] = useState(() => secrets(connection?.headerKeys));
  const [env, setEnv] = useState(() => secrets(connection?.envKeys));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [importJson, setImportJson] = useState('');
  const disabled = busy || !compatible;
  const importConfiguration = () => {
    setError('');
    try {
      const parsed: unknown = JSON.parse(importJson);
      const object = (value: unknown): value is Record<string, unknown> =>
        Boolean(value && typeof value === 'object' && !Array.isArray(value));
      if (!object(parsed)) throw new Error('La configuración debe ser un objeto JSON.');
      let source = parsed;
      let importedName = '';
      if ('mcpServers' in source) {
        if (!object(source.mcpServers) || Object.keys(source.mcpServers).length !== 1)
          throw new Error('Importa un solo servidor dentro de mcpServers.');
        const [key, value] = Object.entries(source.mcpServers)[0];
        if (!object(value)) throw new Error('El servidor debe ser un objeto JSON.');
        source = value;
        importedName = key;
      }
      if (source.type && !['stdio', 'http', 'streamable-http'].includes(String(source.type)))
        throw new Error('Solo se admiten servidores HTTP o locales (stdio).');
      const importedTransport = source.command ? 'stdio' : 'http';
      if (
        importedTransport === 'stdio'
          ? typeof source.command !== 'string'
          : typeof source.url !== 'string'
      )
        throw new Error('Indica un comando local o una URL HTTP en la configuración.');
      if (
        source.args !== undefined &&
        (!Array.isArray(source.args) || source.args.some((arg) => typeof arg !== 'string'))
      )
        throw new Error('Los argumentos deben ser una lista de textos.');
      const importedSecrets = (value: unknown): SecretDraft => {
        if (value === undefined) return secrets();
        if (!object(value) || Object.values(value).some((item) => typeof item !== 'string'))
          throw new Error('Las cabeceras y variables deben contener nombres y valores de texto.');
        return {
          mode: 'replace',
          rows: Object.entries(value).map(([key, item]) => ({ key, value: item as string })),
        };
      };
      const nextHeaders = importedSecrets(source.headers);
      const nextEnv = importedSecrets(source.env);
      setTransport(importedTransport);
      setName(importedName || (typeof source.name === 'string' ? source.name : name));
      setUrl(typeof source.url === 'string' ? source.url : '');
      setCommand(typeof source.command === 'string' ? source.command : '');
      setArgs(Array.isArray(source.args) ? source.args.join('\n') : '');
      setCwd(typeof source.cwd === 'string' ? source.cwd : '');
      setAuth(source.headers ? 'headers' : 'none');
      setHeaders(nextHeaders);
      setEnv(nextEnv);
      setImportJson('');
    } catch (reason) {
      setError(
        reason instanceof SyntaxError
          ? 'El JSON no es válido. Revisa su formato.'
          : reason instanceof Error
            ? reason.message
            : String(reason),
      );
    }
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      if (!name.trim()) throw new Error('Pon un nombre a la conexión.');
      if (transport === 'http') {
        const endpoint = new URL(url.trim());
        if (!['http:', 'https:'].includes(endpoint.protocol))
          throw new Error('La URL debe empezar por https:// o http://.');
        if (endpoint.username || endpoint.password)
          throw new Error('Introduce las credenciales en las cabeceras, fuera de la URL.');
      } else if (!command.trim()) throw new Error('Indica el comando del servidor local.');
      const input: McpConnectionInput = {
        ...(connection ? { id: connection.id } : {}),
        name: name.trim(),
        identity: identity.trim(),
        transport,
        ...(transport === 'http'
          ? {
              url: url.trim(),
              auth,
              ...(auth === 'headers'
                ? { headers: secretPayload(headers, 'cabecera', true) }
                : { headers: null }),
              env: null,
            }
          : {
              command: command.trim(),
              args: args.split(/\r?\n/).filter((line) => line.trim()),
              cwd: cwd.trim(),
              auth: 'none',
              env: secretPayload(env, 'variable'),
              headers: null,
            }),
      };
      if (input.headers === undefined) delete input.headers;
      if (input.env === undefined) delete input.env;
      const result = await run({ type: 'saveMcpConnection', connection: input });
      if (!result || result.ok === false)
        throw new Error(result?.error || 'No se ha podido guardar la conexión.');
      close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="mcp-form"
      onSubmit={save}
      aria-label={connection ? 'Editar conexión' : 'Nueva conexión'}
      aria-busy={busy}
    >
      <div className="mcp-section-title">
        <h4>{connection ? 'Editar conexión' : 'Nueva conexión'}</h4>
        <button
          type="button"
          className="mcp-icon-button"
          aria-label="Cerrar formulario de conexión"
          onClick={close}
          disabled={busy}
        >
          <X size={15} />
        </button>
      </div>
      {!connection && (
        <details className="mcp-import">
          <summary>Importar configuración JSON</summary>
          <label className="mcp-field">
            Configuración de un servidor
            <textarea
              rows={4}
              value={importJson}
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              onChange={(event) => setImportJson(event.target.value)}
              placeholder={'{ "mcpServers": { "mi-servidor": { "url": "https://…/mcp" } } }'}
            />
          </label>
          <p className="mcp-help">
            Admite un servidor HTTP o stdio. Revisa los campos antes de guardar.
          </p>
          <button
            type="button"
            disabled={disabled || !importJson.trim()}
            onClick={importConfiguration}
          >
            Usar configuración
          </button>
        </details>
      )}
      <div className="mcp-form-columns">
        <label className="mcp-field">
          Nombre
          <input
            autoFocus
            required
            maxLength={120}
            placeholder="Documentación del equipo"
            value={name}
            disabled={disabled}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="mcp-field">
          Identidad <span className="mcp-optional">(opcional)</span>
          <input
            placeholder="Cuenta de trabajo"
            maxLength={160}
            value={identity}
            disabled={disabled}
            onChange={(event) => setIdentity(event.target.value)}
          />
        </label>
      </div>
      <label className="mcp-field">
        Tipo de servidor
        <select
          value={transport}
          disabled={disabled}
          onChange={(event) => setTransport(event.target.value as McpTransport)}
        >
          <option value="http">Remoto · HTTP</option>
          <option value="stdio">Local · comando</option>
        </select>
      </label>
      {transport === 'http' ? (
        <>
          <label className="mcp-field">
            URL del servidor
            <input
              type="url"
              required
              placeholder="https://servicio.example/mcp"
              autoComplete="off"
              spellCheck={false}
              value={url}
              disabled={disabled}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <label className="mcp-field">
            Autenticación
            <select
              value={auth}
              disabled={disabled}
              onChange={(event) => setAuth(event.target.value as McpAuth)}
            >
              <option value="none">Sin autenticación</option>
              <option value="oauth">Iniciar sesión en el navegador (OAuth)</option>
              <option value="headers">Cabeceras / token de acceso</option>
            </select>
          </label>
          {auth === 'headers' && (
            <SecretFields
              title="Cabeceras"
              keys={connection?.headerKeys ?? []}
              value={headers}
              onChange={setHeaders}
              disabled={disabled}
              header
            />
          )}
          {auth === 'oauth' && (
            <p className="mcp-help">
              Guarda la conexión y pulsa «Iniciar sesión» para autorizarla en el navegador.
            </p>
          )}
        </>
      ) : (
        <>
          <label className="mcp-field">
            Comando
            <input
              required
              placeholder="npx"
              autoComplete="off"
              spellCheck={false}
              value={command}
              disabled={disabled}
              onChange={(event) => setCommand(event.target.value)}
            />
          </label>
          <label className="mcp-field">
            Argumentos <span className="mcp-optional">(uno por línea)</span>
            <textarea
              rows={3}
              placeholder={'-y\n@organizacion/servidor-mcp'}
              autoComplete="off"
              spellCheck={false}
              value={args}
              disabled={disabled}
              onChange={(event) => setArgs(event.target.value)}
            />
          </label>
          <label className="mcp-field">
            Directorio de trabajo <span className="mcp-optional">(opcional)</span>
            <input
              placeholder="/ruta/al/proyecto"
              autoComplete="off"
              spellCheck={false}
              value={cwd}
              disabled={disabled}
              onChange={(event) => setCwd(event.target.value)}
            />
          </label>
          <SecretFields
            title="Variables de entorno"
            keys={connection?.envKeys ?? []}
            value={env}
            onChange={setEnv}
            disabled={disabled}
          />
          <p className="mcp-help">
            El comando se ejecuta al comprobar la conexión o usarla en un chat.
          </p>
        </>
      )}
      {error && (
        <p className="mcp-error" role="alert">
          {error}
        </p>
      )}
      <div className="mcp-form-actions">
        <button type="button" disabled={busy} onClick={close}>
          Cancelar
        </button>
        <button type="submit" className="mcp-primary" disabled={disabled}>
          {busy ? <LoaderCircle size={14} className="mcp-spin" /> : <Check size={14} />}Guardar
          conexión
        </button>
      </div>
    </form>
  );
}

function connectionStatus(connection: McpConnection) {
  if (connection.authenticating) return 'Esperando autorización';
  return {
    unchecked: 'Sin comprobar',
    checking: 'Comprobando…',
    connected: 'Comprobada',
    error: 'Error al comprobar',
    'needs-auth': 'Necesita iniciar sesión',
  }[connection.status];
}

function endpointLabel(connection: McpConnection) {
  if (connection.transport === 'stdio') return connection.command || 'Servidor local';
  try {
    const url = new URL(connection.url!);
    return `${url.host}${url.pathname}`;
  } catch {
    return 'Servidor remoto';
  }
}

function ConnectionCard({
  connection,
  state,
  compatible,
  run,
  edit,
  editing,
}: {
  connection: McpConnection;
  state: Snapshot;
  compatible: boolean;
  run: (action: Action) => Promise<any>;
  edit: () => void;
  editing: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    setError('');
    setConfirmDelete(false);
  }, [connection.revision]);
  const projects = state.projects.filter((project) =>
    project.mcpConnectionIds?.includes(connection.id),
  );
  const overrideChats = state.sessions.filter((session) =>
    session.mcpConnectionIds?.includes(connection.id),
  );
  const execute = async (action: Action) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await run(action);
      if (!result || result.ok === false)
        throw new Error(result?.error || 'No se ha podido completar la acción.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const disabled =
    !compatible || busy || editing || connection.status === 'checking' || connection.authenticating;
  return (
    <article
      className="mcp-card"
      aria-label={connection.name}
      aria-busy={busy || connection.status === 'checking'}
    >
      <div className="mcp-card-heading">
        <div className="mcp-connection-icon">
          <Cable size={18} aria-hidden="true" />
        </div>
        <div className="mcp-connection-name">
          <h4>{connection.name}</h4>
          <small>
            {connection.identity ||
              (connection.transport === 'http' ? 'Servidor remoto' : 'Servidor local')}
          </small>
        </div>
        <span className={`mcp-status mcp-status-${connection.status}`} role="status">
          {connectionStatus(connection)}
        </span>
      </div>
      <p className="mcp-endpoint">{endpointLabel(connection)}</p>
      <p className="mcp-help">
        {projects.length
          ? `Proyectos: ${projects.map((project) => project.name).join(', ')}`
          : 'Sin proyectos asignados'}
        {overrideChats.length
          ? ` · ${overrideChats.length} ${overrideChats.length === 1 ? 'chat con selección propia' : 'chats con selección propia'}`
          : ''}
      </p>
      {connection.checkedAt && (
        <p className="mcp-help">
          Última comprobación: {new Date(connection.checkedAt).toLocaleString()}
        </p>
      )}
      {(error || connection.error) && (
        <p className="mcp-error" role="alert">
          {error || connection.error}
        </p>
      )}
      <div className="mcp-card-actions">
        {connection.authenticating ? (
          <button
            disabled={!compatible || cancelling}
            onClick={async () => {
              setCancelling(true);
              setError('');
              try {
                const result = await run({ type: 'cancelMcpAuthentication', id: connection.id });
                if (!result || result.ok === false)
                  throw new Error(result?.error || 'No se ha podido cancelar la autorización.');
              } catch (reason) {
                setError(reason instanceof Error ? reason.message : String(reason));
              } finally {
                setCancelling(false);
              }
            }}
          >
            <X size={13} />
            Cancelar autorización
          </button>
        ) : (
          <>
            <button
              disabled={disabled}
              onClick={() => void execute({ type: 'testMcpConnection', id: connection.id })}
            >
              <RefreshCw size={13} className={connection.status === 'checking' ? 'mcp-spin' : ''} />
              Comprobar
            </button>
            {connection.auth === 'oauth' && (
              <button
                disabled={disabled}
                onClick={() =>
                  void execute({ type: 'authenticateMcpConnection', id: connection.id })
                }
              >
                <KeyRound size={13} />
                {connection.status === 'connected' ? 'Volver a iniciar sesión' : 'Iniciar sesión'}
              </button>
            )}
          </>
        )}
        <span className="mcp-actions-spacer" />
        <button
          className="mcp-icon-button"
          aria-label={`Editar ${connection.name}`}
          title="Editar conexión"
          disabled={disabled}
          onClick={edit}
        >
          <Pencil size={14} />
        </button>
        <button
          className="mcp-icon-button"
          aria-label={`Eliminar ${connection.name}`}
          title="Eliminar conexión"
          disabled={disabled}
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 size={14} />
        </button>
      </div>
      {confirmDelete && (
        <div className="mcp-delete-confirm">
          <p>¿Eliminar «{connection.name}» y quitarla de sus proyectos y chats?</p>
          <div className="mcp-form-actions">
            <button disabled={busy} onClick={() => setConfirmDelete(false)}>
              Conservar
            </button>
            <button
              className="mcp-danger"
              disabled={disabled}
              onClick={() => void execute({ type: 'deleteMcpConnection', id: connection.id })}
            >
              Eliminar conexión
            </button>
          </div>
        </div>
      )}
      {connection.tools && (
        <details className="mcp-tools">
          <summary>
            {connection.tools.length}{' '}
            {connection.tools.length === 1
              ? 'herramienta descubierta'
              : 'herramientas descubiertas'}
          </summary>
          {connection.tools.length ? (
            <ul>
              {connection.tools.map((tool, index) => (
                <li key={`${tool.name}-${index}`}>
                  <code>{tool.name}</code>
                  {tool.description && <p>{tool.description}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mcp-help">El servidor no ha publicado herramientas.</p>
          )}
        </details>
      )}
    </article>
  );
}

export function McpSettings({
  state,
  run,
  compatible,
  connectionSessionId,
}: {
  state: Snapshot;
  run: (action: Action) => Promise<any>;
  compatible: boolean;
  connectionSessionId?: string;
}) {
  const session = state.sessions.find((item) => item.id === connectionSessionId);
  const [projectId, setProjectId] = useState(
    session?.projectId ?? state.selectedProject ?? state.projects[0]?.id ?? '',
  );
  useEffect(() => {
    if (session) setProjectId(session.projectId);
  }, [session?.id]);
  const project = state.projects.find((item) => item.id === projectId) ?? state.projects[0];
  const [editing, setEditing] = useState<McpConnection | 'new'>();
  const connections = state.mcpConnections ?? [];
  return (
    <div className="mcp-settings">
      <div className="mcp-section-title">
        <h3>Conexiones MCP</h3>
        <button disabled={!compatible || Boolean(editing)} onClick={() => setEditing('new')}>
          <Plus size={14} />
          Añadir conexión
        </button>
      </div>
      <p className="mcp-help">
        Conecta herramientas externas y elige en qué proyectos y chats se pueden usar.
      </p>
      {session && (
        <McpSelection
          key={session.id}
          state={state}
          projectId={session.projectId}
          session={session}
          run={run}
        />
      )}
      {!compatible && (
        <p className="mcp-help" role="status">
          Actualiza o reinicia Agent Desk para gestionar conexiones.
        </p>
      )}
      {editing && (
        <ConnectionForm
          key={editing === 'new' ? 'new' : editing.id}
          connection={editing === 'new' ? undefined : editing}
          compatible={compatible}
          run={run}
          close={() => setEditing(undefined)}
        />
      )}
      {!connections.length && !editing && (
        <div className="mcp-empty">
          <Cable size={25} aria-hidden="true" />
          <h4>Tus herramientas, dentro del chat</h4>
          <p>
            Añade un servidor remoto o local, comprueba sus herramientas y habilítalo en un
            proyecto.
          </p>
          <button disabled={!compatible} onClick={() => setEditing('new')}>
            <Plus size={14} />
            Añadir la primera conexión
          </button>
        </div>
      )}
      {connections.length > 0 && (
        <>
          <div className="mcp-connection-list">
            {connections.map((connection) => (
              <ConnectionCard
                key={connection.id}
                connection={connection}
                state={state}
                compatible={compatible}
                run={run}
                edit={() => setEditing(connection)}
                editing={Boolean(editing)}
              />
            ))}
          </div>
          <p className="mcp-help">
            «Comprobada» confirma la última prueba del servidor. La selección por proyecto y chat
            determina dónde se utiliza.
          </p>
        </>
      )}
      {project && (
        <div className="mcp-assignment">
          <div className="mcp-section-title">
            <h3>Dónde se utilizan</h3>
          </div>
          <label className="mcp-field">
            Proyecto
            <select value={project.id} onChange={(event) => setProjectId(event.target.value)}>
              {state.projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <McpSelection key={project.id} state={state} projectId={project.id} run={run} />
        </div>
      )}
      {!project && connections.length > 0 && (
        <p className="mcp-help">Abre o añade un proyecto para elegir sus conexiones.</p>
      )}
    </div>
  );
}
