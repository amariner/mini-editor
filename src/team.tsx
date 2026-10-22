import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Circle, Users, X } from 'lucide-react';
import type { Action, Session, Snapshot } from './shared';
import { cardStatus } from './supervision';
import { chatDetachHint, useChatDetachDrag } from './chat-detach-drag';

function ProjectChatRow({
  session,
  selected,
  project,
  floating,
  open,
  remove,
  run,
}: {
  session: Session;
  selected: boolean;
  project?: string;
  floating: boolean;
  open: (session: Session) => void;
  remove: (session: Session) => void;
  run: (action: Action) => Promise<unknown>;
}) {
  const [tone, status] = cardStatus(session);
  const { handleProps, preview, dragging } = useChatDetachDrag({
    session,
    run,
    floating,
    sourceZone: '.sidebar',
  });
  return (
    <>
      <div className={`project-chat-target ${dragging ? 'detaching' : ''}`}>
        <button
          type="button"
          {...handleProps}
          className={`project-chat ${selected ? 'selected' : ''}`}
          onClick={() => open(session)}
          aria-current={selected ? 'true' : undefined}
          title={`${session.title} · ${status}\n${chatDetachHint}`}
        >
          <span>{session.title}</span>
          {project && <small>{project}</small>}
        </button>
        <span className={`project-chat-status ${tone}`} aria-hidden="true">
          <Circle size={7} fill="currentColor" />
        </span>
        <button
          type="button"
          className="project-chat-delete"
          aria-label={`Eliminar chat ${session.title}`}
          title={`Eliminar definitivamente «${session.title}»`}
          onClick={() => remove(session)}
        >
          <X size={13} />
        </button>
      </div>
      {preview}
    </>
  );
}

export function ProjectChats({
  state,
  projectId,
  hiddenChats,
  open,
  remove,
  run,
}: {
  state: Snapshot;
  projectId: string;
  hiddenChats: string[];
  open: (s: Session) => void;
  remove: (s: Session) => void;
  run: (action: Action) => Promise<unknown>;
}) {
  const [folded, setFolded] = useState<string[]>([]);
  const visibleSessions = state.sessions.filter((s) => !hiddenChats.includes(s.id));
  const roots = visibleSessions.filter(
    (s) =>
      s.projectId === projectId &&
      (!s.parentId || !visibleSessions.some((p) => p.id === s.parentId)),
  );
  const row = (s: Session, child = false) => (
    <ProjectChatRow
      session={s}
      selected={state.selectedSession === s.id}
      project={
        child && s.projectId !== projectId
          ? state.projects.find((p) => p.id === s.projectId)?.name
          : undefined
      }
      floating={!!state.floatingChats?.some((chat) => chat.sessionId === s.id)}
      open={open}
      remove={remove}
      run={run}
    />
  );
  return (
    <div className="project-chats">
      {roots.map((s) => {
        const children = visibleSessions.filter((c) => c.parentId === s.id);
        const collapsed = folded.includes(s.id);
        return (
          <div key={s.id}>
            <div className="project-chat-row">
              {!!children.length && (
                <button
                  className="team-fold"
                  aria-label={`${collapsed ? 'Expandir' : 'Plegar'} subchats de ${s.title}`}
                  aria-expanded={!collapsed}
                  onClick={() =>
                    setFolded((ids) =>
                      collapsed ? ids.filter((id) => id !== s.id) : [...ids, s.id],
                    )
                  }
                >
                  {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                </button>
              )}
              {row(s)}
            </div>
            {!!children.length && !collapsed && (
              <div className="project-subchats">
                {children.map((c) => (
                  <div key={c.id} className="project-chat-row">
                    {row(c, true)}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** One small entry point, shared by the full chat and grid headers. */
export function TeamIndicator({
  session,
  sessions,
  open,
  compact = false,
}: {
  session: Session;
  sessions: Session[];
  open: (session: Session) => void;
  compact?: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<'first' | 'last'>('first');
  const [expanded, setExpanded] = useState(false);
  const root = session.parentId ?? session.id;
  const members = sessions.filter((s) => s.id === root || s.parentId === root);
  const agents = session.subagents ?? [];
  const linked = members.length > 1;
  const available = linked || agents.length > 0;
  const working = members.filter((s) => ['working', 'starting'].includes(s.status)).length;
  useLayoutEffect(() => {
    if (!available) {
      setExpanded(false);
      return;
    }
    if (!expanded || !popup.current || !trigger.current) return;
    const panel = popup.current;
    const anchor = trigger.current;
    const position = () => {
      const rect = anchor.getBoundingClientRect();
      const margin = 8;
      const gap = 6;
      const below = Math.max(0, innerHeight - margin - rect.bottom - gap);
      const above = Math.max(0, rect.top - gap - margin);
      const naturalHeight = panel.scrollHeight + panel.offsetHeight - panel.clientHeight;
      const flip = naturalHeight > below && above > below;
      panel.style.maxHeight = `${Math.max(0, Math.min(innerHeight - margin * 2, flip ? above : below))}px`;
      const bounds = panel.getBoundingClientRect();
      panel.style.left = `${Math.max(margin, Math.min(rect.left, innerWidth - bounds.width - margin))}px`;
      panel.style.top = `${Math.max(margin, Math.min(flip ? rect.top - gap - bounds.height : rect.bottom + gap, innerHeight - bounds.height - margin))}px`;
    };
    position();
    const buttons = panel.querySelectorAll<HTMLButtonElement>('button:enabled');
    (buttons[initialFocus.current === 'last' ? buttons.length - 1 : 0] ?? panel).focus({
      preventScroll: true,
    });
    initialFocus.current = 'first';
    const observer = new ResizeObserver(position);
    observer.observe(anchor);
    observer.observe(panel);
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
    };
  }, [expanded, available]);
  if (!available) return null;
  const label = [
    linked ? `${members.length} chats` : '',
    agents.length ? `${agents.length} ${agents.length === 1 ? 'agente' : 'agentes'}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      <button
        ref={trigger}
        className={`team-indicator ${compact ? 'compact' : ''}`}
        popoverTarget={id}
        aria-label={`Ver equipo: ${label}`}
        aria-expanded={expanded}
        aria-controls={id}
        aria-haspopup="dialog"
        title={`Equipo · ${label}`}
        onKeyDown={(event) => {
          if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
          event.preventDefault();
          initialFocus.current = event.key === 'ArrowUp' ? 'last' : 'first';
          const panel = popup.current;
          if (panel?.matches(':popover-open')) {
            const buttons = panel.querySelectorAll<HTMLButtonElement>('button:enabled');
            (buttons[initialFocus.current === 'last' ? buttons.length - 1 : 0] ?? panel).focus();
            initialFocus.current = 'first';
          } else panel?.showPopover();
        }}
      >
        <Users size={13} />
        <span>{compact ? (linked ? members.length : 0) + agents.length : label}</span>
        {working > 0 && <i className="team-active" title={`${working} chats trabajando`} />}
      </button>
      <div
        id={id}
        ref={popup}
        popover="auto"
        className="team-popover"
        role="dialog"
        aria-label={`Equipo de ${session.title}`}
        tabIndex={-1}
        onToggle={(e) => setExpanded(e.newState === 'open')}
        onBlur={(event) => {
          if (
            event.relatedTarget &&
            event.relatedTarget !== trigger.current &&
            !event.currentTarget.contains(event.relatedTarget)
          )
            popup.current?.hidePopover();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            popup.current?.hidePopover();
            trigger.current?.focus({ preventScroll: true });
            return;
          }
          const panel = popup.current;
          if (!panel) return;
          if (event.key === 'PageDown' || event.key === 'PageUp') {
            event.preventDefault();
            panel.scrollBy({ top: panel.clientHeight * (event.key === 'PageDown' ? 0.8 : -0.8) });
          }
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const buttons = [...panel.querySelectorAll<HTMLButtonElement>('button:enabled')];
          if (!buttons.length) {
            if (event.key === 'Home' || event.key === 'End')
              panel.scrollTop = event.key === 'Home' ? 0 : panel.scrollHeight;
            else panel.scrollBy({ top: event.key === 'ArrowDown' ? 44 : -44 });
            return;
          }
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next].focus();
          buttons[next].scrollIntoView({ block: 'nearest' });
        }}
      >
        {linked &&
          members.map((s) => (
            <button
              key={s.id}
              className="team-member"
              aria-current={s.id === session.id ? 'true' : undefined}
              onClick={() => {
                popup.current?.hidePopover();
                open(s);
              }}
            >
              <span>
                <strong>{s.title}</strong>
                <small>
                  {s.id === root ? 'Coordinador · ' : ''}
                  {cardStatus(s)[1]}
                </small>
              </span>
              <Circle size={6} fill="currentColor" className={cardStatus(s)[0]} />
            </button>
          ))}
        {agents.map((agent) => (
          <div className="team-member" key={agent.id}>
            <span>
              <strong>{agent.description || 'Agente'}</strong>
              <small>
                {agent.summary && agent.summary.trim() !== agent.description?.trim()
                  ? agent.summary
                  : 'Trabajando'}
              </small>
            </span>
            <i className="team-active" />
          </div>
        ))}
      </div>
    </>
  );
}
