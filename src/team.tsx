import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Users, X } from 'lucide-react';
import type { Action, Session, Snapshot } from './shared';
import { cardStatus } from './supervision';
import { chatDetachHint, useChatDetachDrag } from './chat-detach-drag';
import { ChatStateMark } from './chat-state-mark';
import { chatOrderGroup, orderSiblingChats, type ChatOrderEdge } from './chat-order';
import { useChatOrder } from './use-chat-order';
import { EditableName } from './editable-name';

type DropTarget = { sessionId: string; edge: ChatOrderEdge };

function ProjectChatRow({
  session,
  selected,
  project,
  floating,
  unread,
  open,
  remove,
  run,
  dragMove,
  dragEnd,
  dropInside,
  moveBy,
}: {
  session: Session;
  selected: boolean;
  project?: string;
  floating: boolean;
  unread: boolean;
  open: (session: Session) => void;
  remove: (session: Session) => void;
  run: (action: Action) => Promise<unknown>;
  dragMove: (session: Session, x: number, y: number, outside: boolean) => void;
  dragEnd: () => void;
  dropInside: (session: Session, x: number, y: number) => void;
  moveBy: (session: Session, direction: -1 | 1) => void;
}) {
  const [tone, status] = cardStatus(session);
  const trigger = useRef<HTMLButtonElement>(null);
  const [renaming, setRenaming] = useState(false);
  const { handleProps, preview, dragging } = useChatDetachDrag({
    session,
    run,
    floating,
    disabled: renaming,
    sourceZone: '.sidebar',
    onDragMove: (x, y, outside) => dragMove(session, x, y, outside),
    onDragEnd: dragEnd,
    onDropInside: (x, y) => dropInside(session, x, y),
  });
  const finishRename = () => {
    const from = document.activeElement;
    setRenaming(false);
    requestAnimationFrame(() => {
      if (document.activeElement === document.body || document.activeElement === from)
        trigger.current?.focus({ preventScroll: true });
    });
  };
  return (
    <>
      <div
        className={`project-chat-target ${dragging ? 'detaching reordering' : ''} ${tone === 'done' ? 'chat-completed' : ''} ${tone === 'done' && unread ? 'completion-unread' : ''}`}
      >
        {renaming ? (
          <EditableName
            value={session.title}
            label="Nombre del chat"
            save={(title) => void run({ type: 'rename', sessionId: session.id, title })}
            close={finishRename}
          />
        ) : (
          <>
            <button
              ref={trigger}
              type="button"
              {...handleProps}
              className={`project-chat ${selected ? 'selected' : ''}`}
              onClick={() => open(session)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setRenaming(true);
              }}
              onKeyDown={(event) => {
                handleProps.onKeyDown?.(event);
                if (event.defaultPrevented) return;
                if (event.key === 'F2') {
                  event.preventDefault();
                  event.stopPropagation();
                  setRenaming(true);
                  return;
                }
                if (!event.altKey || event.shiftKey) return;
                if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                event.preventDefault();
                event.stopPropagation();
                moveBy(session, event.key === 'ArrowUp' ? -1 : 1);
              }}
              aria-keyshortcuts="F2 Alt+ArrowUp Alt+ArrowDown Alt+Shift+F"
              aria-current={selected ? 'true' : undefined}
              title={`${session.title} · ${status}\nF2 o clic derecho para renombrar · Arrastra para ordenar · Alt + ↑/↓ para mover · ${chatDetachHint}`}
            >
              <span>{session.title}</span>
              {project && <small>{project}</small>}
            </button>
            <span className={`project-chat-status ${tone}`} aria-hidden="true">
              <ChatStateMark tone={tone} status={status} unread={unread} />
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
          </>
        )}
      </div>
      {preview}
    </>
  );
}

export function ProjectChats({
  state,
  projectId,
  hiddenChats,
  unreadCompleted,
  open,
  remove,
  run,
}: {
  state: Snapshot;
  projectId: string;
  hiddenChats: string[];
  unreadCompleted?: ReadonlySet<string>;
  open: (s: Session) => void;
  remove: (s: Session) => void;
  run: (action: Action) => Promise<unknown>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const dragPoint = useRef<{ session: Session; x: number; y: number } | undefined>(undefined);
  const scrollFrame = useRef(0);
  const [folded, setFolded] = useState<string[]>([]);
  const [drop, setDrop] = useState<DropTarget>();
  const [announcement, setAnnouncement] = useState('');
  const { order, move } = useChatOrder(state.sessions);
  const visibleSessions = state.sessions.filter((s) => !hiddenChats.includes(s.id));
  const visibleIds = new Set(visibleSessions.map((s) => s.id));
  const childrenByParent = new Map<string, Session[]>();
  for (const session of visibleSessions) {
    if (!session.parentId) continue;
    const siblings = childrenByParent.get(session.parentId) ?? [];
    siblings.push(session);
    childrenByParent.set(session.parentId, siblings);
  }
  const roots = visibleSessions.filter(
    (s) => s.projectId === projectId && (!s.parentId || !visibleIds.has(s.parentId)),
  );
  const findDrop = (session: Session, x: number, y: number): DropTarget | undefined => {
    const rows = container.current?.querySelectorAll<HTMLElement>('.project-chat-row');
    if (!rows) return;
    const group = chatOrderGroup(session);
    for (const row of rows) {
      if (row.dataset.orderGroup !== group || row.dataset.sessionId === session.id) continue;
      const bounds = row.getBoundingClientRect();
      if (y < bounds.top || y > bounds.bottom || x < bounds.left || x > bounds.right) continue;
      return {
        sessionId: row.dataset.sessionId!,
        edge: y < bounds.top + bounds.height / 2 ? 'before' : 'after',
      };
    }
  };
  const markDrop = (next?: DropTarget) =>
    setDrop((previous) =>
      previous?.sessionId === next?.sessionId && previous?.edge === next?.edge ? previous : next,
    );
  const clearDrag = () => {
    dragPoint.current = undefined;
    cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = 0;
    markDrop();
  };
  useLayoutEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);
  const dragMove = (session: Session, x: number, y: number, outside: boolean) => {
    if (outside) {
      clearDrag();
      return;
    }
    dragPoint.current = { session, x, y };
    markDrop(findDrop(session, x, y));
    if (scrollFrame.current) return;
    const scroll = () => {
      scrollFrame.current = 0;
      const point = dragPoint.current;
      const viewport = container.current?.closest<HTMLElement>('.projects');
      if (!point || !viewport) return;
      const bounds = viewport.getBoundingClientRect();
      const edge = 28;
      const distance =
        point.y < bounds.top + edge
          ? point.y - bounds.top - edge
          : point.y > bounds.bottom - edge
            ? point.y - bounds.bottom + edge
            : 0;
      if (!distance) return;
      const previous = viewport.scrollTop;
      viewport.scrollTop += Math.sign(distance) * Math.min(12, Math.ceil(Math.abs(distance) / 3));
      if (previous === viewport.scrollTop) return;
      markDrop(findDrop(point.session, point.x, point.y));
      scrollFrame.current = requestAnimationFrame(scroll);
    };
    scrollFrame.current = requestAnimationFrame(scroll);
  };
  const moveBy = (session: Session, direction: -1 | 1) => {
    const siblings = order[chatOrderGroup(session)]?.filter((id) => visibleIds.has(id)) ?? [];
    const index = siblings.indexOf(session.id);
    const target = siblings[index + direction];
    if (!target || !move(session.id, target, direction === -1 ? 'before' : 'after')) return;
    setAnnouncement(`${session.title}: posición ${index + direction + 1} de ${siblings.length}`);
    requestAnimationFrame(() => {
      const rows = container.current?.querySelectorAll<HTMLElement>('.project-chat-row');
      const row = rows && [...rows].find((item) => item.dataset.sessionId === session.id);
      row?.querySelector<HTMLButtonElement>('.project-chat')?.focus({ preventScroll: true });
      row?.scrollIntoView({ block: 'nearest' });
    });
  };
  const renderGroup = (siblings: Session[], ancestors = new Set<string>()): React.ReactNode =>
    orderSiblingChats(siblings, order).map((session) => {
      if (ancestors.has(session.id)) return null;
      const children = childrenByParent.get(session.id) ?? [];
      const collapsed = folded.includes(session.id);
      const nextAncestors = new Set(ancestors).add(session.id);
      return (
        <div key={session.id} data-session-group={session.id}>
          <div
            className="project-chat-row"
            data-session-id={session.id}
            data-order-group={chatOrderGroup(session)}
            data-reorder-edge={drop?.sessionId === session.id ? drop.edge : undefined}
          >
            {!!children.length && (
              <button
                className="team-fold"
                aria-label={`${collapsed ? 'Expandir' : 'Plegar'} subchats de ${session.title}`}
                aria-expanded={!collapsed}
                onClick={() =>
                  setFolded((ids) =>
                    collapsed ? ids.filter((id) => id !== session.id) : [...ids, session.id],
                  )
                }
              >
                {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              </button>
            )}
            <ProjectChatRow
              session={session}
              selected={state.selectedSession === session.id}
              project={
                session.projectId !== projectId
                  ? state.projects.find((p) => p.id === session.projectId)?.name
                  : undefined
              }
              floating={!!state.floatingChats?.some((chat) => chat.sessionId === session.id)}
              unread={!!unreadCompleted?.has(session.id)}
              open={open}
              remove={remove}
              run={run}
              moveBy={moveBy}
              dragMove={dragMove}
              dragEnd={clearDrag}
              dropInside={(source, x, y) => {
                const target = findDrop(source, x, y);
                if (target && move(source.id, target.sessionId, target.edge))
                  setAnnouncement(`Se ha cambiado la posición de ${source.title}`);
              }}
            />
          </div>
          {!!children.length && !collapsed && (
            <div className="project-subchats">{renderGroup(children, nextAncestors)}</div>
          )}
        </div>
      );
    });
  return (
    <div className="project-chats" ref={container}>
      {renderGroup(roots)}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
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
              <ChatStateMark tone={cardStatus(s)[0]} status={cardStatus(s)[1]} />
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
            <ChatStateMark tone="working" status="Trabajando" />
          </div>
        ))}
      </div>
    </>
  );
}
