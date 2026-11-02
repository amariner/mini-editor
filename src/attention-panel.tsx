import React, { useId, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCheck,
  CircleHelp,
  Inbox,
  ShieldCheck,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { Action, Project, Session } from './shared';
import { providerKind, providerNames } from './shared';
import { attentionPendingCount, type AttentionItem } from './attention';
import { cardStatus } from './supervision';
import { hasUnreadTurn } from './session-supervision';
import { Markdown } from './markdown';
import { ChatStateMark } from './chat-state-mark';

const messageText = (s: Session) => [...s.messages].reverse().find((m) => m.role === 'assistant');
const excerpt = (s: Session) => {
  const m = messageText(s);
  return m?.blocks
    ? m.blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n\n')
    : (m?.text ?? '');
};
const elapsed = (s: Session) => {
  const stamp = s.supervision?.finishedAt ?? s.supervision?.startedAt;
  if (!stamp) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - stamp) / 60000));
  return minutes < 1 ? 'Ahora' : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`;
};

/** Global supervision with a stable, in-place preview. Only the original chat decides approvals. */
export function AttentionPanel({
  items,
  projects,
  sessions = [],
  run,
  onSelect,
  onClose,
}: {
  items: AttentionItem[];
  projects: Project[];
  sessions?: Session[];
  run?: (a: Action) => Promise<unknown>;
  onSelect: (session: Session) => void;
  onClose: () => void;
}) {
  const headingId = useId();
  const list = useRef<HTMLDivElement>(null);
  const [scope, setScope] = useState<'pending' | 'all'>('pending');
  const [sort, setSort] = useState<'priority' | 'project'>('priority');
  const [selected, setSelected] = useState<AttentionItem>();
  const pending = attentionPendingCount(items);
  const current =
    selected &&
    (sessions.find((s) => s.id === selected.session.id) ??
      items.find((i) => i.session.id === selected.session.id)?.session);
  const preview = selected && current ? { ...selected, session: current } : undefined;
  const source =
    scope === 'pending'
      ? items
      : sessions
          .filter((s) => s.mode !== 'terminal' && s.status !== 'terminal')
          .map((s): AttentionItem => {
            const own = items.find((i) => i.session.id === s.id);
            if (own) return own;
            const child = items.find(
              (i) =>
                i.session.parentId === s.id &&
                ['permission', 'question', 'error', 'delivery'].includes(i.kind),
            );
            return {
              session: s,
              kind: child?.kind ?? 'completed',
              label: child ? 'Un auxiliar necesita atención' : cardStatus(s)[1],
              detail: child
                ? `${child.session.title} · ${child.detail}`
                : s.activity || excerpt(s).slice(0, 220) || 'Sin actividad reciente.',
            };
          });
  const rank = (s: Session) => {
    const tone = cardStatus(s)[0];
    return tone === 'attention'
      ? 0
      : tone === 'error'
        ? 1
        : hasUnreadTurn(s)
          ? 2
          : tone === 'working'
            ? 3
            : 4;
  };
  const ordered =
    scope === 'all' && sort === 'priority'
      ? [...source].sort((a, b) => {
          const inherited = (i: AttentionItem) =>
            i.label === 'Un auxiliar necesita atención' ? 0 : rank(i.session);
          return inherited(a) - inherited(b);
        })
      : source;
  const groups =
    sort === 'project'
      ? projects.map((p) => ({
          title: p.name,
          items: ordered.filter((i) => i.session.projectId === p.id),
        }))
      : scope === 'all'
        ? [{ title: 'Todos los agentes', items: ordered }]
        : [
            {
              title: 'Necesitan tu atención',
              items: ordered.filter((i) => i.kind !== 'completed'),
            },
            { title: 'Listos para revisar', items: ordered.filter((i) => i.kind === 'completed') },
          ];
  const back = () => {
    const id = selected?.session.id;
    setSelected(undefined);
    requestAnimationFrame(() => {
      const buttons = [
        ...(list.current?.querySelectorAll<HTMLButtonElement>('.attention-item') ?? []),
      ];
      (buttons.find((b) => b.dataset.sessionId === id) ?? buttons[0])?.focus();
    });
  };
  return (
    <div className="overlay attention-overlay" onClick={onClose}>
      <section
        className="attention-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            preview ? back() : onClose();
            return;
          }
          if (preview || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
          const buttons = [
            ...(list.current?.querySelectorAll<HTMLButtonElement>('.attention-item') ?? []),
          ];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (index < 0 || !buttons.length) return;
          e.preventDefault();
          const next =
            e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? buttons.length - 1
                : Math.max(
                    0,
                    Math.min(buttons.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)),
                  );
          buttons[next].focus();
          buttons[next].scrollIntoView({ block: 'nearest' });
        }}
      >
        <header className="attention-heading">
          <span className="attention-heading-icon">
            <Inbox size={18} />
          </span>
          <div>
            <h2 id={headingId}>Centro de atención</h2>
            <p aria-live="polite">
              {pending
                ? `${pending} ${pending === 1 ? 'chat necesita' : 'chats necesitan'} tu atención`
                : 'Todo al día'}
              {!!(items.length - pending) && ` · ${items.length - pending} por revisar`}
            </p>
          </div>
          <button
            type="button"
            aria-label="Cerrar centro de atención"
            title="Cerrar"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        {preview ? (
          <>
            <div className="attention-preview-heading">
              <button type="button" data-autofocus onClick={back}>
                <ArrowLeft size={14} /> Volver a agentes
              </button>
              <small>
                {cardStatus(preview.session)[1]}
                {elapsed(preview.session) && ` · ${elapsed(preview.session)}`}
              </small>
            </div>
            <div
              className="attention-preview"
              tabIndex={0}
              aria-label={`Vista rápida de ${preview.session.title}`}
            >
              <p className="muted">
                {projects.find((p) => p.id === preview.session.projectId)?.name} ·{' '}
                {providerNames[providerKind(preview.session.profile)]}
              </p>
              <h3>{preview.session.title}</h3>
              {preview.session.approvals.length > 0 && (
                <div className="inline-notice">
                  {items.find((i) => i.session.id === preview.session.id)?.detail || preview.detail}
                  <p>Abre el chat para responder con todo el contexto.</p>
                </div>
              )}
              {preview.session.error && <p role="status">{preview.session.error}</p>}
              {preview.session.activity && <p>{preview.session.activity}</p>}
              {excerpt(preview.session) ? (
                <Markdown text={excerpt(preview.session).slice(-12000)} />
              ) : (
                <p className="muted">Todavía no hay una respuesta disponible.</p>
              )}
              {preview.session.tasks?.length ? (
                <p className="muted">
                  {preview.session.tasks.length} tareas en segundo plano. Interrumpir un turno no
                  confirma su cierre.
                </p>
              ) : null}
              {sessions
                .filter((s) => s.parentId === preview.session.id)
                .map((s) => (
                  <button
                    type="button"
                    className="attention-child"
                    key={s.id}
                    onClick={() =>
                      setSelected(
                        items.find((i) => i.session.id === s.id) ?? {
                          session: s,
                          kind: 'completed',
                          label: cardStatus(s)[1],
                          detail: '',
                        },
                      )
                    }
                  >
                    {s.title}
                    <small>{cardStatus(s)[1]}</small>
                  </button>
                ))}
              {preview.session.agentDeliveries?.length ? (
                <div className="agent-deliveries">
                  <h4>Entregas de auxiliares</h4>
                  {[...preview.session.agentDeliveries].reverse().map((a) => (
                    <details key={a.id}>
                      <summary>
                        {a.description} ·{' '}
                        {a.outcome === 'completed'
                          ? 'Terminado'
                          : a.outcome === 'failed'
                            ? 'Falló'
                            : 'Interrumpido'}
                      </summary>
                      <p>{a.summary || 'Sin resumen disponible.'}</p>
                    </details>
                  ))}
                </div>
              ) : null}
            </div>
            <footer className="attention-preview-actions">
              {run && hasUnreadTurn(preview.session) && (
                <button
                  type="button"
                  onClick={() =>
                    run({
                      type: 'markSessionRead',
                      sessionId: preview.session.id,
                      revision: preview.session.supervision!.revision,
                    })
                  }
                >
                  Marcar revisado
                </button>
              )}
              {run && preview.session.mode !== 'terminal' && (
                <button
                  type="button"
                  onClick={() =>
                    run({ type: 'floatingChat', operation: 'open', sessionId: preview.session.id })
                  }
                >
                  Ventana flotante
                </button>
              )}
              <button type="button" className="primary" onClick={() => onSelect(preview.session)}>
                Abrir chat <ArrowUpRight size={14} />
              </button>
            </footer>
          </>
        ) : (
          <>
            <div className="attention-controls">
              <div role="group" aria-label="Agentes visibles">
                <button
                  type="button"
                  aria-pressed={scope === 'pending'}
                  onClick={() => setScope('pending')}
                >
                  Pendientes
                </button>
                <button
                  type="button"
                  aria-pressed={scope === 'all'}
                  onClick={() => setScope('all')}
                >
                  Todos
                </button>
              </div>
              <label>
                Orden{' '}
                <select
                  aria-label="Ordenar agentes"
                  value={sort}
                  onChange={(e) => setSort(e.target.value as typeof sort)}
                >
                  <option value="priority">Prioridad</option>
                  <option value="project">Por proyecto</option>
                </select>
              </label>
            </div>
            <div className="attention-list" ref={list}>
              {groups
                .filter((g) => g.items.length)
                .map((g) => (
                  <section key={g.title} aria-label={g.title}>
                    <h3>
                      {g.title}
                      <span>{g.items.length}</span>
                    </h3>
                    {g.items.map((item) => {
                      const Icon =
                        item.kind === 'completed'
                          ? CheckCheck
                          : item.kind === 'question'
                            ? CircleHelp
                            : item.kind === 'permission'
                              ? ShieldCheck
                              : TriangleAlert;
                      return (
                        <button
                          type="button"
                          className={`attention-item attention-${item.kind} attention-tone-${cardStatus(item.session)[0]}`}
                          key={item.session.id}
                          data-session-id={item.session.id}
                          data-autofocus={item === ordered[0] ? true : undefined}
                          aria-label={`${item.session.title} · ${item.label}`}
                          onClick={(e) => {
                            setSelected(item);
                          }}
                        >
                          {scope === 'all' ? (
                            <ChatStateMark
                              tone={
                                item.label === 'Un auxiliar necesita atención'
                                  ? 'attention'
                                  : cardStatus(item.session)[0]
                              }
                              status={item.label}
                              unread={hasUnreadTurn(item.session)}
                            />
                          ) : (
                            <Icon className="attention-item-icon" size={17} />
                          )}
                          <span className="attention-item-body">
                            <span className="attention-item-context">
                              <span>
                                {projects.find((p) => p.id === item.session.projectId)?.name ??
                                  'Proyecto'}{' '}
                                · {providerNames[providerKind(item.session.profile)]}
                              </span>
                              <span className="attention-item-label">
                                {item.label}
                                {(item.requests ?? 0) > 1 ? ` · ${item.requests}` : ''}
                              </span>
                            </span>
                            <strong>{item.session.title}</strong>
                            <span className="attention-item-detail">{item.detail}</span>
                            {item.changes && (
                              <span className="attention-item-changes">
                                {item.changes.files.length} archivos cambiados{' '}
                                <span className="added">+{item.changes.added}</span>
                                <span className="removed">−{item.changes.removed}</span>
                              </span>
                            )}
                          </span>
                          <small className="attention-elapsed">{elapsed(item.session)}</small>
                          <ArrowUpRight className="attention-open" size={15} aria-hidden="true" />
                        </button>
                      );
                    })}
                  </section>
                ))}
              {!ordered.length && (
                <div className="attention-empty" role="status">
                  <CheckCheck size={26} />
                  <strong>
                    {scope === 'pending' ? 'No hay nada pendiente' : 'Todavía no hay agentes'}
                  </strong>
                  <p>Las solicitudes y las nuevas respuestas de tus agentes aparecerán aquí.</p>
                </div>
              )}
            </div>
            <footer className="attention-footer">
              <span>Todos los proyectos · Todos los agentes</span>
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd> recorrer <kbd>↵</kbd> vista rápida
              </span>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
