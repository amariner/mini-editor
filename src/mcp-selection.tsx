import React, { useState } from 'react';
import { effectiveMcpIds, supportsManagedMcp } from './mcp-types';
import { compatibleRuntime } from './runtime';
import type { Action, Session, Snapshot } from './shared';
import './mcp-settings.css';

export function McpSelection({
  state,
  projectId,
  session,
  run,
}: {
  state: Snapshot;
  projectId: string;
  session?: Session;
  run: (action: Action) => Promise<any>;
}) {
  const project = state.projects.find((item) => item.id === projectId);
  const connections = state.mcpConnections ?? [];
  const selected = effectiveMcpIds(project, session);
  const inherits = session?.mcpConnectionIds === undefined;
  const supported = !session || supportsManagedMcp(session.profile, session.mode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async (connectionIds: string[] | null) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await run(
        session
          ? { type: 'setSessionMcpConnections', sessionId: session.id, connectionIds }
          : { type: 'setProjectMcpConnections', projectId, connectionIds: connectionIds ?? [] },
      );
      if (!result || result.ok === false)
        throw new Error(result?.error || 'No se han podido guardar las conexiones.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  if (!project) return null;
  const disabled = busy || !supported || !compatibleRuntime(state);
  return (
    <section
      className="mcp-selection"
      aria-label={session ? 'Conexiones del chat' : 'Conexiones del proyecto'}
      aria-busy={busy}
    >
      <div className="mcp-section-title">
        <h4>{session ? session.title || 'Este chat' : 'Por defecto en el proyecto'}</h4>
        <span className="mcp-count">
          {selected.length} {selected.length === 1 ? 'seleccionada' : 'seleccionadas'}
        </span>
      </div>
      {session ? (
        <label className="mcp-field">
          Conexiones de este chat
          <select
            value={inherits ? 'inherit' : 'custom'}
            disabled={disabled}
            onChange={(event) => void save(event.target.value === 'inherit' ? null : [...selected])}
          >
            <option value="inherit">Usar las del proyecto</option>
            <option value="custom">Elegir para este chat</option>
          </select>
        </label>
      ) : (
        <p className="mcp-help">
          Se usan en los chats de Claude y Codex que siguen los ajustes del proyecto.
        </p>
      )}
      {!supported && (
        <p className="mcp-help">
          Este chat no admite conexiones MCP gestionadas. Están disponibles en los chats de Claude y
          Codex.
        </p>
      )}
      {connections.length ? (
        <div className="mcp-choices">
          {connections.map((connection) => {
            const checked = selected.includes(connection.id);
            const applied = session?.mcpAppliedIds?.includes(connection.id);
            return (
              <label key={connection.id} className="mcp-choice">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled || Boolean(session && inherits)}
                  onChange={(event) =>
                    void save(
                      event.target.checked
                        ? [...selected, connection.id]
                        : selected.filter((id) => id !== connection.id),
                    )
                  }
                />
                <span>
                  <strong>{connection.name}</strong>
                  {connection.identity && <small>{connection.identity}</small>}
                </span>
                {session && supported && (checked || applied) && (
                  <small className="mcp-choice-state">
                    {session.mcpPending
                      ? 'Pendiente'
                      : applied
                        ? 'Aplicada al chat'
                        : 'Próximo inicio'}
                  </small>
                )}
              </label>
            );
          })}
        </div>
      ) : (
        <p className="mcp-help">Añade una conexión para habilitarla aquí.</p>
      )}
      {session && supported && (
        <p className="mcp-help" role="status">
          {session.mcpPending
            ? 'Cambios pendientes: se aplicarán al iniciar el próximo turno del chat.'
            : 'La selección se aplica al iniciar un turno. Comprueba la conexión para verificar sus herramientas.'}
        </p>
      )}
      {error && (
        <p className="mcp-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
