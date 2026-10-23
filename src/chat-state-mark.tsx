import React from 'react';
import { CircleAlert, CircleHelp } from 'lucide-react';
import { DeskMark } from './project-mark';
import type { Session } from './shared';
import { cardStatus, type CardTone } from './supervision';
import './chat-state-mark.css';

/** A running process may be idle: only actual work should animate the project mark. */
export function projectChatStatus(sessions: Session[]): [CardTone, string] {
  const states = sessions.map(cardStatus);
  for (const tone of ['attention', 'error', 'working', 'done', 'idle'] as const) {
    const state = states.find(([candidate]) => candidate === tone);
    if (state) return state;
  }
  return ['idle', 'Sin chats'];
}

/** The same state vocabulary in project headers, chats and their children. */
export const ChatStateMark = React.memo(function ChatStateMark({
  tone,
  status,
  unread = false,
}: {
  tone: CardTone;
  status?: string;
  unread?: boolean;
}) {
  return (
    <span
      className={`chat-state-mark ${tone}${tone === 'done' && unread ? ' unread' : ''}`}
      role={status ? 'img' : undefined}
      aria-label={status}
      aria-hidden={status ? undefined : true}
    >
      {tone === 'working' ? (
        <DeskMark size={14} />
      ) : tone === 'done' ? (
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <circle cx="6" cy="6" r="2.25" fill="currentColor" />
        </svg>
      ) : tone === 'attention' ? (
        <CircleHelp size={12} strokeWidth={1.5} aria-hidden="true" />
      ) : tone === 'error' ? (
        <CircleAlert size={12} strokeWidth={1.5} aria-hidden="true" />
      ) : (
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <circle cx="6" cy="6" r="2" fill="none" stroke="currentColor" strokeWidth="1" />
        </svg>
      )}
    </span>
  );
});
