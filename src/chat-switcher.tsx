import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Circle, Pencil } from 'lucide-react';
import type { Action, Session } from './shared';
import { EditableName } from './editable-name';
import { cardStatus } from './supervision';
import { useChatDetachDrag } from './chat-detach-drag';
import './chat-navigation.css';
import { orderedProjectChats } from './chat-order';
import { useChatOrder } from './use-chat-order';

// Selection replaces this component. Keep the focus request across that replacement,
// and consume it only after React commits an enabled trigger for the selected chat.
let pendingFocus: { sessionId: string; cancel: () => void } | undefined;
function requestSelectionFocus(sessionId: string) {
  pendingFocus?.cancel();
  let timer: ReturnType<typeof setTimeout>;
  const cancel = () => {
    clearTimeout(timer);
    window.removeEventListener('pointerdown', cancel, true);
    window.removeEventListener('keydown', cancel, true);
    window.removeEventListener('blur', cancel);
    if (pendingFocus?.cancel === cancel) pendingFocus = undefined;
  };
  pendingFocus = { sessionId, cancel };
  // New input takes precedence over a selection still waiting for the backend.
  window.addEventListener('pointerdown', cancel, true);
  window.addEventListener('keydown', cancel, true);
  window.addEventListener('blur', cancel);
  timer = setTimeout(cancel, 30_000);
  return cancel;
}

/** The active chat stays beside its project; its menu includes every chat in that project. */
export function ChatSwitcher({
  session,
  sessions,
  projectName,
  select,
  run,
  disabled = false,
  floating = false,
}: {
  session: Session;
  sessions: Session[];
  projectName: string;
  select: (session: Session) => void | Promise<unknown>;
  run: (action: Action) => Promise<unknown>;
  disabled?: boolean;
  floating?: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<'selected' | 'first' | 'last'>('selected');
  const [expanded, setExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const { order } = useChatOrder(sessions);
  const chats = orderedProjectChats(sessions, session.projectId, order);
  const { handleProps, preview, dragging } = useChatDetachDrag({
    session,
    run,
    disabled: disabled || floating || renaming,
    sourceZone: '.git-summary',
    onDragMove: () => popup.current?.hidePopover(),
  });
  const focusTrigger = () => {
    const from = document.activeElement;
    requestAnimationFrame(() => {
      if (document.activeElement === document.body || document.activeElement === from)
        trigger.current?.focus({ preventScroll: true });
    });
  };
  const rename = () => {
    if (disabled) return;
    popup.current?.hidePopover();
    setRenaming(true);
  };

  useLayoutEffect(() => {
    if (!expanded || !popup.current || !trigger.current) return;
    const panel = popup.current;
    const anchor = trigger.current;
    const position = () => {
      const rect = anchor.getBoundingClientRect();
      const margin = 8;
      const gap = 6;
      const below = Math.max(0, innerHeight - rect.bottom - margin - gap);
      const above = Math.max(0, rect.top - margin - gap);
      const flip = above > below;
      panel.style.maxHeight = `${Math.max(0, Math.min(420, flip ? above : below))}px`;
      const bounds = panel.getBoundingClientRect();
      panel.style.left = `${Math.max(margin, Math.min(rect.left, innerWidth - bounds.width - margin))}px`;
      panel.style.top = `${Math.max(margin, Math.min(flip ? rect.top - gap - bounds.height : rect.bottom + gap, innerHeight - bounds.height - margin))}px`;
    };
    position();
    const buttons = panel.querySelectorAll<HTMLButtonElement>('button:enabled');
    const target =
      initialFocus.current === 'selected'
        ? panel.querySelector<HTMLButtonElement>('[aria-checked="true"]')
        : buttons[initialFocus.current === 'last' ? buttons.length - 1 : 0];
    (target ?? buttons[0] ?? panel).focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest' });
    initialFocus.current = 'selected';
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
  }, [expanded]);

  useLayoutEffect(() => {
    if (disabled) popup.current?.hidePopover();
  }, [disabled]);

  useLayoutEffect(() => {
    if (disabled || renaming || pendingFocus?.sessionId !== session.id || !trigger.current) return;
    pendingFocus.cancel();
    trigger.current.focus({ preventScroll: true });
  }, [session.id, disabled, renaming]);

  return (
    <div className={`chat-switcher ${dragging ? 'chat-switcher-dragging' : ''}`}>
      {renaming ? (
        <EditableName
          value={session.title}
          label="Nombre del chat"
          save={(title) => void run({ type: 'rename', sessionId: session.id, title })}
          close={() => {
            setRenaming(false);
            focusTrigger();
          }}
        />
      ) : (
        <button
          {...handleProps}
          ref={trigger}
          type="button"
          className="chat-switcher-trigger"
          data-session-id={session.id}
          aria-label={`Cambiar de chat: ${session.title}`}
          aria-haspopup="menu"
          aria-controls={id}
          aria-expanded={expanded}
          disabled={disabled}
          title={`${session.title} · Cambiar de chat · F2 para renombrar${floating ? '' : ' · Arrastra para abrir en una ventana'}`}
          onClick={(event) => {
            if (event.defaultPrevented) return;
            popup.current?.togglePopover();
          }}
          onKeyDown={(event) => {
            handleProps.onKeyDown?.(event);
            if (event.defaultPrevented) return;
            if (event.key === 'F2') {
              event.preventDefault();
              rename();
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              initialFocus.current = event.key === 'ArrowUp' ? 'last' : 'first';
              popup.current?.showPopover();
            }
          }}
        >
          <span>{session.title}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      )}
      <div
        ref={popup}
        id={id}
        className="chat-switcher-menu"
        popover="auto"
        role="menu"
        aria-label={`Chats de ${projectName}`}
        tabIndex={-1}
        onToggle={(event) => setExpanded(event.newState === 'open')}
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
            focusTrigger();
            return;
          }
          if (event.key === 'F2') {
            event.preventDefault();
            rename();
            return;
          }
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const buttons = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:enabled'),
          ];
          if (!buttons.length) return;
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next].focus({ preventScroll: true });
          buttons[next].scrollIntoView({ block: 'nearest' });
        }}
      >
        <div className="chat-switcher-heading" aria-hidden="true">
          <span>{projectName}</span>
          <small>
            {chats.length} {chats.length === 1 ? 'chat' : 'chats'}
          </small>
        </div>
        <div className="chat-switcher-list" role="group" aria-label="Conversaciones del proyecto">
          {chats.map((chat) => {
            const [tone, status] = cardStatus(chat);
            return (
              <button
                key={chat.id}
                type="button"
                className="chat-switcher-option"
                role="menuitemradio"
                aria-checked={chat.id === session.id}
                tabIndex={-1}
                disabled={disabled}
                title={`${chat.title} · ${status}`}
                onClick={async () => {
                  popup.current?.hidePopover();
                  if (chat.id !== session.id) {
                    const cancelFocus = requestSelectionFocus(chat.id);
                    try {
                      await select(chat);
                    } catch (error) {
                      cancelFocus();
                      throw error;
                    }
                  } else focusTrigger();
                }}
              >
                <Circle
                  size={7}
                  fill="currentColor"
                  className={`chat-switcher-status ${tone}`}
                  aria-hidden="true"
                />
                <span>
                  <strong>{chat.title}</strong>
                  <small>
                    {chat.parentId ? 'Subchat · ' : ''}
                    {status}
                  </small>
                </span>
                {chat.id === session.id && <Check size={13} aria-hidden="true" />}
              </button>
            );
          })}
        </div>
        <button
          className="chat-switcher-rename"
          type="button"
          role="menuitem"
          tabIndex={-1}
          disabled={disabled}
          onClick={rename}
        >
          <Pencil size={13} aria-hidden="true" />
          <span>Cambiar nombre del chat</span>
          <kbd>F2</kbd>
        </button>
      </div>
      {preview}
    </div>
  );
}
