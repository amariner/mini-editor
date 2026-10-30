import React, { useEffect, useRef, useState } from 'react';
import { ExternalLink, Globe, Link2, RefreshCw, Square, X } from 'lucide-react';
import type { ChromeConnection, ChromeMode } from './chrome-types';
import type { BrowserState } from './browser-protocol';
import type { Action } from './shared';
import { actionError } from './runtime';

const statusLabels: Record<ChromeConnection['status'], string> = {
  connecting: 'Conectando…',
  connected: 'Conectado',
  disconnected: 'Desconectado',
  error: 'Requiere atención',
};

export function ChromeControls({
  connections,
  tabs,
  tab,
  projectId,
  sessionId,
  select,
  openIntegrated,
  expanded,
  onExpandedChange,
  id,
}: {
  connections: ChromeConnection[];
  tabs: BrowserState[];
  tab?: BrowserState;
  projectId?: string;
  sessionId?: string;
  select: (id: string) => void;
  openIntegrated: () => Promise<void>;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  id: string;
}) {
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState('');
  const request = useRef<{ mode: ChromeMode; projectId?: string } | undefined>(undefined);
  const relevant = connections.filter(
    (connection) => connection.projectId === projectId || connection.id === tab?.connectionId,
  );
  const selected = connections.find((connection) => connection.id === tab?.connectionId);
  const connecting = relevant.some((connection) => connection.status === 'connecting');
  const attention = relevant
    .filter((connection) => connection.status === 'error')
    .map((connection) => `${connection.id}:${connection.error}`)
    .join('|');
  useEffect(() => {
    if (attention) onExpandedChange(true);
  }, [attention, onExpandedChange]);

  // Selecting the new connection waits for its actual tab snapshot, not for an
  // assumed return shape from the main process. Changing projects cancels it.
  useEffect(() => {
    const target = request.current;
    if (!target) return;
    if (target.projectId !== projectId) {
      request.current = undefined;
      return;
    }
    const connection = connections.find(
      (item) => item.mode === target.mode && item.projectId === target.projectId,
    );
    const first = tabs.find((item) => item.connectionId === connection?.id);
    if (connection?.status === 'connected' && first) {
      request.current = undefined;
      select(first.id);
    } else if (connection?.status === 'error') request.current = undefined;
  }, [connections, tabs, projectId, select]);

  const run = async (action: Action, key: string) => {
    setPending(key);
    setError('');
    try {
      await window.desk.invoke(action);
    } catch (cause) {
      request.current = undefined;
      setError(actionError(cause));
      onExpandedChange(true);
    } finally {
      setPending((current) => (current === key ? undefined : current));
    }
  };
  const connect = (mode: ChromeMode) => {
    request.current = { mode, projectId };
    void run({ type: 'chromeConnect', mode, projectId, sessionId }, mode);
  };
  const newConnection = (mode: ChromeMode) =>
    !relevant.some(
      (connection) =>
        connection.mode === mode && ['connected', 'connecting'].includes(connection.status),
    );

  if (!expanded) return null;
  return (
    <div id={id} className="chrome-connections" role="region" aria-label="Control de Chrome">
      <div className="chrome-surface-bar">
        <span>
          <Globe size={12} />
          {tab?.backend === 'chrome'
            ? `Chrome · ${selected?.mode === 'personal' ? 'Tu sesión' : 'Gestionado'}`
            : 'Navegador integrado'}
        </span>
        {tab?.backend === 'chrome' && (
          <button
            type="button"
            onClick={() => {
              setError('');
              void openIntegrated().catch((cause) => setError(actionError(cause)));
            }}
          >
            Integrado
          </button>
        )}
        <button
          type="button"
          aria-label="Cerrar conexiones de Chrome"
          onClick={() => onExpandedChange(false)}
        >
          <X size={12} />
        </button>
      </div>
      <div className="chrome-connection-details">
        <div className="chrome-connect-actions">
          <button
            type="button"
            disabled={!!pending || connecting || !newConnection('personal')}
            onClick={() => connect('personal')}
          >
            <Link2 size={13} />
            Conectar mi Chrome
          </button>
          <button
            type="button"
            disabled={!!pending || connecting || !newConnection('managed')}
            onClick={() => connect('managed')}
          >
            <Globe size={13} />
            Abrir Chrome gestionado
          </button>
        </div>
        <p className="chrome-connect-help">
          Sin extensión. Tu Chrome conserva las sesiones abiertas y pide autorización al conectar.
          Chrome gestionado usa un perfil propio y recuerda tus inicios de sesión.
        </p>
        <button
          type="button"
          className="chrome-setup-link"
          disabled={pending === 'setup'}
          onClick={() => void run({ type: 'chromeSetup' }, 'setup')}
        >
          <ExternalLink size={12} />
          Preparar mi Chrome
        </button>
        <span className="chrome-setup-hint">
          Activa las conexiones de depuración en la página que se abre y después conecta.
        </span>
        {relevant.length > 0 && (
          <ul className="chrome-connection-list">
            {relevant.map((connection) => (
              <li key={connection.id}>
                <div className="chrome-connection-label">
                  <strong>
                    {connection.mode === 'personal' ? 'Mi Chrome' : 'Chrome gestionado'}
                  </strong>
                  <span role="status" className={`chrome-status ${connection.status}`}>
                    <i />
                    {statusLabels[connection.status]}
                    {connection.status === 'connected' &&
                      ` · ${connection.tabCount} ${connection.tabCount === 1 ? 'pestaña' : 'pestañas'}`}
                  </span>
                  {connection.error && <p role="alert">{connection.error}</p>}
                </div>
                <div className="chrome-connection-actions">
                  {connection.status === 'connected' && (
                    <button
                      type="button"
                      onClick={() => {
                        const first = tabs.find((item) => item.connectionId === connection.id);
                        if (first) select(first.id);
                      }}
                      disabled={!tabs.some((item) => item.connectionId === connection.id)}
                    >
                      Ver pestañas
                    </button>
                  )}
                  {['connected', 'connecting'].includes(connection.status) ? (
                    <button
                      type="button"
                      aria-label={`Desconectar ${connection.mode === 'personal' ? 'mi Chrome' : 'Chrome gestionado'}`}
                      title={
                        connection.mode === 'personal'
                          ? 'Detener el control y dejar Chrome abierto'
                          : 'Cerrar la instancia gestionada y conservar su perfil'
                      }
                      disabled={pending === `stop:${connection.id}`}
                      onClick={() => {
                        request.current = undefined;
                        void run(
                          { type: 'chromeDisconnect', connectionId: connection.id },
                          `stop:${connection.id}`,
                        );
                      }}
                    >
                      <Square size={11} />
                      Detener
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={!!pending || connecting}
                      onClick={() => {
                        request.current = {
                          mode: connection.mode,
                          projectId: connection.projectId,
                        };
                        void run(
                          { type: 'chromeReconnect', connectionId: connection.id },
                          connection.id,
                        );
                      }}
                    >
                      <RefreshCw size={12} />
                      Reconectar
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && (
        <p className="browser-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
