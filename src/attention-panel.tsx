import React, { useId, useRef } from 'react';
import {
  ArrowUpRight,
  CheckCheck,
  CircleHelp,
  Inbox,
  ShieldCheck,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { Project, Session } from './shared';
import { providerKind, providerNames } from './shared';
import { attentionPendingCount, type AttentionItem } from './attention';

/** A single, keyboard-friendly queue; decisions stay in their original chat with full context. */
export function AttentionPanel({
  items,
  projects,
  onSelect,
  onClose,
}: {
  items: AttentionItem[];
  projects: Project[];
  onSelect: (session: Session) => void;
  onClose: () => void;
}) {
  const headingId = useId();
  const list = useRef<HTMLDivElement>(null);
  const pending = attentionPendingCount(items);
  const groups = [
    { title: 'Necesitan tu atención', items: items.filter((item) => item.kind !== 'completed') },
    { title: 'Listos para revisar', items: items.filter((item) => item.kind === 'completed') },
  ];
  return (
    <div className="overlay attention-overlay" onClick={onClose}>
      <section
        className="attention-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          const buttons = [
            ...(list.current?.querySelectorAll<HTMLButtonElement>('.attention-item') ?? []),
          ];
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (current < 0 || !buttons.length) return;
          event.preventDefault();
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : Math.max(
                    0,
                    Math.min(buttons.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)),
                  );
          buttons[next].focus();
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
            title="Cerrar (Esc)"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <div className="attention-list" ref={list}>
          {groups
            .filter((group) => group.items.length)
            .map((group) => (
              <section key={group.title} aria-label={group.title}>
                <h3>
                  {group.title}
                  <span>{group.items.length}</span>
                </h3>
                {group.items.map((item) => {
                  const Icon =
                    item.kind === 'completed'
                      ? CheckCheck
                      : item.kind === 'question'
                        ? CircleHelp
                        : item.kind === 'permission'
                          ? ShieldCheck
                          : TriangleAlert;
                  const project = projects.find((project) => project.id === item.session.projectId);
                  return (
                    <button
                      type="button"
                      className={`attention-item attention-${item.kind}`}
                      key={item.session.id}
                      data-autofocus={item === items[0] ? true : undefined}
                      onClick={() => onSelect(item.session)}
                      aria-label={`${item.session.title} · ${item.label}`}
                    >
                      <Icon className="attention-item-icon" size={17} />
                      <span className="attention-item-body">
                        <span className="attention-item-context">
                          <span>
                            {project?.name ?? 'Proyecto'} ·{' '}
                            {providerNames[providerKind(item.session.profile)]}
                          </span>
                          <span className="attention-item-label">
                            {item.label}
                            {(item.requests ?? 0) > 1 ? ` · ${item.requests}` : ''}
                          </span>
                        </span>
                        <strong>{item.session.title}</strong>
                        <span className="attention-item-detail">{item.detail}</span>
                        {!!item.changes && (
                          <span className="attention-item-changes">
                            {item.changes.files.length}{' '}
                            {item.changes.files.length === 1
                              ? 'archivo cambiado'
                              : 'archivos cambiados'}
                            <span className="added">+{item.changes.added}</span>
                            <span className="removed">−{item.changes.removed}</span>
                          </span>
                        )}
                      </span>
                      <ArrowUpRight className="attention-open" size={15} aria-hidden="true" />
                    </button>
                  );
                })}
              </section>
            ))}
          {!items.length && (
            <div className="attention-empty" role="status">
              <CheckCheck size={26} />
              <strong>No hay nada pendiente</strong>
              <p>Las solicitudes y las nuevas respuestas de tus agentes aparecerán aquí.</p>
            </div>
          )}
        </div>
        <footer className="attention-footer">
          <span>Todos los proyectos · Todos los agentes</span>
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> recorrer <kbd>↵</kbd> abrir
          </span>
        </footer>
      </section>
    </div>
  );
}
