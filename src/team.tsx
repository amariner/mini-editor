import React, { useId, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Circle, Users } from 'lucide-react';
import type { Session, Snapshot } from './shared';
import { cardStatus } from './supervision';

export function ProjectChats({
  state,
  projectId,
  hiddenChats,
  open,
}: {
  state: Snapshot;
  projectId: string;
  hiddenChats: string[];
  open: (s: Session) => void;
}) {
  const [folded, setFolded] = useState<string[]>([]);
  const visibleSessions = state.sessions.filter((s) => !hiddenChats.includes(s.id));
  const roots = visibleSessions.filter(
    (s) =>
      s.projectId === projectId &&
      (!s.parentId || !visibleSessions.some((p) => p.id === s.parentId)),
  );
  const row = (s: Session, child = false) => (
    <button
      className={`project-chat ${state.selectedSession === s.id ? 'selected' : ''}`}
      onClick={() => open(s)}
      title={`${s.title} · ${cardStatus(s)[1]}`}
    >
      <span>{s.title}</span>
      {child && s.projectId !== projectId && (
        <small>{state.projects.find((p) => p.id === s.projectId)?.name}</small>
      )}
      <Circle size={7} className={cardStatus(s)[0]} fill="currentColor" />
    </button>
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
                  <div key={c.id}>{row(c, true)}</div>
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
  const popup = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const root = session.parentId ?? session.id;
  const members = sessions.filter((s) => s.id === root || s.parentId === root);
  const agents = session.subagents ?? [];
  const linked = members.length > 1;
  const working = members.filter((s) => ['working', 'starting'].includes(s.status)).length;
  if (!linked && !agents.length) return null;
  const label = [
    linked ? `${members.length} chats` : '',
    agents.length ? `${agents.length} agentes` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      <button
        className={`team-indicator ${compact ? 'compact' : ''}`}
        popoverTarget={id}
        aria-label={`Ver equipo: ${label}`}
        aria-expanded={expanded}
        title={`Equipo · ${label}`}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          if (popup.current) {
            popup.current.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 300))}px`;
            popup.current.style.top = `${rect.bottom + 6}px`;
            popup.current.style.maxHeight = `${Math.max(100, window.innerHeight - rect.bottom - 18)}px`;
          }
        }}
      >
        <Users size={13} />
        <span>{label}</span>
        {working > 0 && <i className="team-active" title={`${working} chats trabajando`} />}
      </button>
      <div
        id={id}
        ref={popup}
        popover="auto"
        className="team-popover"
        onToggle={(e) => setExpanded(e.newState === 'open')}
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
              <small>{agent.summary || 'Trabajando'}</small>
            </span>
            <i className="team-active" />
          </div>
        ))}
      </div>
    </>
  );
}
