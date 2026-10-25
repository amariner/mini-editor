import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PanelRight } from 'lucide-react';
import type { Session } from './shared';
import type { GitSnapshot } from './git-types';
import { compactTokens } from './task-signature';
import './chat-details.css';

export function ChatDetails({
  session,
  project,
  root,
  git,
  gitError,
  showChanges,
  open: controlledOpen,
  onOpenChange,
  triggerMount,
}: {
  session: Session;
  project: string;
  root?: string;
  git?: GitSnapshot;
  gitError?: string;
  showChanges?: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  triggerMount?: HTMLElement | null;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);
  const stats = session.stats;
  const percent = stats?.contextPercent;
  const hasPercent = percent !== undefined && Number.isFinite(percent);
  const hasTokens = !!stats?.tokensReported && (stats.inputTokens > 0 || stats.outputTokens > 0);
  const hasCost = !!stats?.costReported && stats.cost > 0;
  const hasWindow = stats?.contextTokens !== undefined && !!stats.contextMax;
  const servers = session.info?.mcpServers ?? [];
  const files = git?.repository ? git.files : [];
  const branch = session.worktree?.branch ?? (git?.repository ? git.branch : undefined);
  const model =
    session.info?.model ??
    session.config?.model ??
    session.codexConfig?.model ??
    session.providerConfig?.model;
  const location = session.worktree?.cwd ?? root;
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const toggle = (
    <button
      ref={trigger}
      className={`chat-details-toggle ${open ? 'on' : ''}`}
      title="Detalles del chat"
      aria-label="Detalles del chat"
      aria-expanded={open}
      aria-controls={open ? id : undefined}
      onClick={() => setOpen(!open)}
    >
      <PanelRight size={17} />
    </button>
  );
  return (
    <>
      {triggerMount === undefined
        ? toggle
        : triggerMount
          ? createPortal(toggle, triggerMount)
          : null}
      {open && (
        <aside
          id={id}
          ref={panel}
          tabIndex={-1}
          className="chat-details"
          aria-label="Detalles del chat"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            }
          }}
        >
          {(project || location || branch || (model && model !== 'default')) && (
            <details open>
              <summary>Entorno</summary>
              {project && <p>{project}</p>}
              {location && (
                <p className="chat-details-path" title={location}>
                  {location}
                </p>
              )}
              {branch && (
                <p>
                  {branch}
                  {session.worktree && <small>Worktree aislado</small>}
                </p>
              )}
              {model && model !== 'default' && <small>{model}</small>}
            </details>
          )}
          {(hasPercent || hasWindow || hasTokens || hasCost) && (
            <details open>
              <summary>Contexto {hasPercent && <span>{Math.round(percent)} %</span>}</summary>
              {hasPercent && (
                <progress
                  aria-label="Contexto utilizado"
                  max={100}
                  value={Math.min(100, Math.max(0, percent))}
                />
              )}
              {hasWindow && (
                <p>
                  {compactTokens(stats!.contextTokens!)} de {compactTokens(stats!.contextMax!)}{' '}
                  tokens
                </p>
              )}
              {hasTokens && (
                <small>
                  {compactTokens(stats!.inputTokens)} entrada · {compactTokens(stats!.outputTokens)}{' '}
                  salida
                </small>
              )}
              {hasCost && <small>${stats!.cost.toFixed(3)}</small>}
            </details>
          )}
          {(servers.length > 0 || session.mcpPending) && (
            <details>
              <summary>Conectores {servers.length > 0 && <span>{servers.length}</span>}</summary>
              {session.mcpPending && <small>Cambios pendientes de aplicar</small>}
              {servers.map((server) => (
                <p key={server.name}>
                  {server.name}
                  <small>
                    {server.status}
                    {server.error ? ` · ${server.error}` : ''}
                  </small>
                </p>
              ))}
            </details>
          )}
          {(files.length > 0 || gitError) && (
            <details open>
              <summary>Cambios {files.length > 0 && <span>{files.length}</span>}</summary>
              {gitError && <p role="status">{gitError}</p>}
              {files.length > 0 && (
                <>
                  {git?.lines && (
                    <p>
                      <span className="git-added">+{git.lines.added}</span>{' '}
                      <span className="git-removed">−{git.lines.removed}</span>
                    </p>
                  )}
                  {files.slice(0, 30).map((file) => (
                    <p className="chat-details-path" title={file.path} key={file.path}>
                      {file.conflict ? '⚠ ' : ''}
                      {file.path}
                    </p>
                  ))}
                  {files.length > 30 && <small>Y {files.length - 30} más…</small>}
                  {showChanges && <button onClick={showChanges}>Revisar cambios</button>}
                </>
              )}
            </details>
          )}
          {!!session.subagents?.length && (
            <details open>
              <summary>
                Agentes <span>{session.subagents.length}</span>
              </summary>
              {session.subagents.map((a) => (
                <p key={a.id}>
                  {a.description}
                  {(a.summary || a.tool) && <small>{a.summary ?? a.tool}</small>}
                </p>
              ))}
            </details>
          )}
        </aside>
      )}
    </>
  );
}
