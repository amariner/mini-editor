import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PanelRight, X } from 'lucide-react';
import type { Session } from './shared';
import type { GitSnapshot } from './git-types';
import { compactTokens } from './task-signature';
import { usePanelPresence } from './panel-presence';
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
  const presence = usePanelPresence(open);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (open) panel.current?.focus();
    else if (panel.current?.contains(document.activeElement)) trigger.current?.focus();
  }, [open]);

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
      {presence.present && (
        <aside
          id={id}
          ref={panel}
          tabIndex={-1}
          className="chat-details"
          data-open={presence.visible}
          aria-hidden={!open}
          inert={!open}
          aria-label="Detalles del chat"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
        >
          <header className="chat-details-heading">
            <strong>Detalles del chat</strong>
            <button
              type="button"
              aria-label="Cerrar detalles del chat"
              title="Cerrar (Esc)"
              onClick={close}
            >
              <X size={15} />
            </button>
          </header>
          <ChatDetailsContent
            session={session}
            project={project}
            root={root}
            git={git}
            gitError={gitError}
            showChanges={showChanges}
          />
        </aside>
      )}
    </>
  );
}

export type ChatDetailsContentProps = {
  session: Session;
  project: string;
  root?: string;
  git?: GitSnapshot;
  gitError?: string;
  showChanges?: () => void;
};

/** Shared details body for the workspace panel and compact multichat drawers. */
export function ChatDetailsContent({
  session,
  project,
  root,
  git,
  gitError,
  showChanges,
}: ChatDetailsContentProps) {
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
  const status = session.approvals.length
    ? 'Necesita tu atención'
    : {
        stopped: 'Detenido',
        starting: 'Conectando…',
        terminal: 'Terminal activa',
        ready: 'Listo',
        working: 'Trabajando',
        waiting: 'Espera tu respuesta',
        stopping: 'Deteniendo…',
        error: 'Revisar error',
      }[session.status];
  const queued = session.pendingInputs?.filter((input) => input.status !== 'failed').length ?? 0;
  const failed = session.pendingInputs?.filter((input) => input.status === 'failed').length ?? 0;

  return (
    <div className="chat-details-content">
      <div className="chat-details-activity">
        <span
          className={`chat-details-status status-${session.approvals.length ? 'waiting' : session.status}`}
        >
          {status}
        </span>
        {session.error && <p>{session.error}</p>}
        {!session.error &&
          session.activity &&
          ['starting', 'working', 'waiting', 'stopping'].includes(session.status) && (
            <p>{session.activity}</p>
          )}
        {queued > 0 && (
          <small>
            {queued} {queued === 1 ? 'mensaje en cola' : 'mensajes en cola'}
          </small>
        )}
        {failed > 0 && (
          <small>
            {failed} {failed === 1 ? 'mensaje sin enviar' : 'mensajes sin enviar'}. Revisa el
            compositor.
          </small>
        )}
      </div>
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
              {compactTokens(stats!.contextTokens!)} de {compactTokens(stats!.contextMax!)} tokens
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
    </div>
  );
}
