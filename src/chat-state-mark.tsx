import React from 'react';
import { Check, CircleAlert, MessageCircleQuestion } from 'lucide-react';
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
        <DeskMark size={16} />
      ) : tone === 'done' ? (
        <Check size={13} strokeWidth={2.2} aria-hidden="true" />
      ) : tone === 'attention' ? (
        <MessageCircleQuestion size={14} aria-hidden="true" />
      ) : tone === 'error' ? (
        <CircleAlert size={14} aria-hidden="true" />
      ) : (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="3" fill="currentColor" />
        </svg>
      )}
    </span>
  );
});
