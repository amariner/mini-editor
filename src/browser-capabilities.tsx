import React, { useEffect, useState } from 'react';
import { Download, FolderOpen, Pause, Play, X, ShieldCheck } from 'lucide-react';
import type { BrowserState } from './browser-protocol';
import type { BrowserDownload } from './browser-downloads';
import type { Action } from './shared';

const size = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
const states: Record<BrowserDownload['state'], string> = {
  progress: 'Descargando',
  paused: 'En pausa',
  completed: 'Completada',
  cancelled: 'Cancelada',
  interrupted: 'Interrumpida',
};
const site = (value: string) => {
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? 'Página actual' : origin;
  } catch {
    return 'Página actual';
  }
};

export function BrowserCapabilities({
  tab,
  downloads,
  onError,
}: {
  tab?: BrowserState;
  downloads: BrowserDownload[];
  onError: (message: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState('');
  const [prompt, setPrompt] = useState('');
  useEffect(() => setPrompt(tab?.dialog?.defaultPrompt ?? ''), [tab?.dialog?.id]);
  const newest = downloads[0]?.id;
  useEffect(() => {
    if (newest) setExpanded(true);
  }, [newest]);
  const run = async (action: Action, key: string) => {
    if (busy) return;
    setBusy(key);
    try {
      await window.desk.invoke(action);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy('');
    }
  };
  const dialog = tab?.dialog;
  const permission = tab?.permissions?.[0];
  return (
    <>
      {dialog && tab && (
        <form
          className="browser-site-request"
          aria-label="Diálogo de la página"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              {
                type: 'browserTab',
                tabId: tab.id,
                input: {
                  action: 'dialog',
                  dialogId: dialog.id,
                  accept: true,
                  ...(dialog.type === 'prompt' ? { promptText: prompt } : {}),
                },
              },
              dialog.id,
            );
          }}
        >
          <strong>
            {dialog.type === 'beforeunload'
              ? 'Salir de esta página'
              : 'La página solicita una respuesta'}
          </strong>
          <p className="muted">{site(dialog.url || tab.url)}</p>
          <p>
            {dialog.message ||
              (dialog.type === 'beforeunload'
                ? 'Puede haber cambios sin guardar.'
                : 'Confirma para continuar.')}
          </p>
          {dialog.type === 'prompt' && (
            <input
              autoFocus
              aria-label="Respuesta al diálogo"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              maxLength={20000}
            />
          )}
          <div className="browser-request-actions">
            {dialog.type !== 'alert' && (
              <button
                type="button"
                disabled={!!busy}
                onClick={() =>
                  void run(
                    {
                      type: 'browserTab',
                      tabId: tab.id,
                      input: { action: 'dialog', dialogId: dialog.id, accept: false },
                    },
                    dialog.id,
                  )
                }
              >
                Cancelar
              </button>
            )}
            <button type="submit" disabled={!!busy}>
              {dialog.type === 'alert' ? 'Cerrar aviso' : 'Aceptar'}
            </button>
          </div>
        </form>
      )}
      {permission && tab && (
        <section className="browser-site-request" aria-label="Permiso de la página">
          <strong>
            <ShieldCheck size={13} />
            {permission.label}
          </strong>
          <p>{permission.origin}</p>
          {permission.detail && <p>{permission.detail}</p>}
          <div className="browser-request-actions">
            <button
              disabled={!!busy}
              onClick={() =>
                void run(
                  {
                    type: 'browserPermission',
                    tabId: tab.id,
                    permissionId: permission.id,
                    allow: false,
                  },
                  permission.id,
                )
              }
            >
              Bloquear
            </button>
            <button
              disabled={!!busy}
              onClick={() =>
                void run(
                  {
                    type: 'browserPermission',
                    tabId: tab.id,
                    permissionId: permission.id,
                    allow: true,
                  },
                  permission.id,
                )
              }
            >
              Permitir una vez
            </button>
          </div>
        </section>
      )}
      {downloads.length > 0 && (
        <section className="browser-downloads" aria-label="Descargas del navegador">
          <button
            className="browser-downloads-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <Download size={13} />
            <span>Descargas</span>
            <span>
              {downloads.filter((item) => ['progress', 'paused'].includes(item.state)).length ||
                downloads.length}
            </span>
          </button>
          {expanded && (
            <ul>
              {downloads.map((item) => (
                <li key={item.id}>
                  <div className="browser-download-info">
                    <strong title={item.path || item.fileName}>{item.fileName}</strong>
                    <span>
                      {states[item.state]} · {size(item.receivedBytes)}
                      {item.totalBytes > 0 ? ` / ${size(item.totalBytes)}` : ''}
                    </span>
                    {['progress', 'paused'].includes(item.state) && item.canCancel !== false && (
                      <progress
                        aria-label={`Progreso de ${item.fileName}`}
                        max={item.totalBytes || undefined}
                        value={item.totalBytes ? item.receivedBytes : undefined}
                      />
                    )}
                    {item.error && <span role="status">{item.error}</span>}
                    {item.state === 'completed' && !item.path && (
                      <span>Consulta la ubicación en el navegador.</span>
                    )}
                  </div>
                  <div className="browser-download-actions">
                    {item.state === 'completed' && item.path && (
                      <button
                        title="Mostrar en Finder"
                        aria-label={`Mostrar ${item.fileName} en Finder`}
                        disabled={!!busy}
                        onClick={() =>
                          void run(
                            {
                              type: 'browserDownloadReveal',
                              tabId: item.tabId,
                              downloadId: item.id,
                            },
                            item.id,
                          )
                        }
                      >
                        <FolderOpen size={13} />
                      </button>
                    )}
                    {item.state === 'progress' && item.canPause !== false && (
                      <button
                        title="Pausar descarga"
                        aria-label={`Pausar ${item.fileName}`}
                        disabled={!!busy}
                        onClick={() =>
                          void run(
                            {
                              type: 'browserDownloadControl',
                              tabId: item.tabId,
                              downloadId: item.id,
                              operation: 'pause',
                            },
                            item.id,
                          )
                        }
                      >
                        <Pause size={13} />
                      </button>
                    )}
                    {(item.state === 'paused' || item.state === 'interrupted') &&
                      item.canResume && (
                        <button
                          title="Reanudar descarga"
                          aria-label={`Reanudar ${item.fileName}`}
                          disabled={!!busy}
                          onClick={() =>
                            void run(
                              {
                                type: 'browserDownloadControl',
                                tabId: item.tabId,
                                downloadId: item.id,
                                operation: 'resume',
                              },
                              item.id,
                            )
                          }
                        >
                          <Play size={13} />
                        </button>
                      )}
                    {['progress', 'paused'].includes(item.state) && (
                      <button
                        title="Cancelar descarga"
                        aria-label={`Cancelar ${item.fileName}`}
                        disabled={!!busy}
                        onClick={() =>
                          void run(
                            {
                              type: 'browserDownloadControl',
                              tabId: item.tabId,
                              downloadId: item.id,
                              operation: 'cancel',
                            },
                            item.id,
                          )
                        }
                      >
                        <X size={13} />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
