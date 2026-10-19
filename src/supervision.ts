import type { Session } from './shared';
import { sessionIsLive } from './session-tabs';
import { fileChanges, type FileChange } from './activity';
/** Pure projections for supervising many chats at once: state, plan, changes and next step. */
export type CardTone = 'attention' | 'error' | 'working' | 'idle' | 'done';
export const isPending = (s: Session) =>
  ['working', 'starting', 'waiting', 'stopping'].includes(s.status) || !!s.approvals.length;
export function cardStatus(session: Session): [CardTone, string] {
  if (session.approvals.length) return ['attention', 'Permiso o respuesta pendiente'];
  if (session.status === 'waiting') return ['attention', 'Esperando tu respuesta'];
  if (session.status === 'error' || session.error) return ['error', 'Error'];
  if (session.status === 'working') return ['working', 'Trabajando'];
  if (session.status === 'starting') return ['working', 'Abriendo…'];
  if (session.status === 'stopping') return ['working', 'Cerrando…'];
  if (session.mode === 'terminal' || session.status === 'terminal')
    return ['idle', sessionIsLive(session) ? 'Terminal abierta' : 'Terminal detenida'];
  if (session.messages.some((m) => m.role === 'assistant')) return ['done', 'Terminado'];
  return ['idle', 'En espera'];
}
export const needsAttention = (s: Session) => ['attention', 'error'].includes(cardStatus(s)[0]);
/** The Dock badge: chats waiting on you, the same ones the grid flags as needing attention. */
export function attentionBadge(sessions: Session[]) {
  const count = sessions.filter(needsAttention).length;
  return count ? String(count) : '';
}
export interface PlanProgress {
  done: number;
  total: number;
  current?: string;
}
/** TodoWrite/plan progress while it is still relevant: a live chat or unfinished steps. */
export function planProgress(session: Session): PlanProgress | undefined {
  const todos = session.todos ?? [];
  if (!todos.length) return undefined;
  if (!sessionIsLive(session) && todos.every((t) => t.status === 'completed')) return undefined;
  const current = todos.find((t) => t.status === 'in_progress');
  return {
    done: todos.filter((t) => t.status === 'completed').length,
    total: todos.length,
    current: current ? current.activeForm || current.content : undefined,
  };
}
export interface TurnChanges {
  files: FileChange[];
  added: number;
  removed: number;
}
/** Files changed since your last message, including the turn still running. */
export function lastTurnChanges(session: Session): TurnChanges | undefined {
  let start = session.messages.length;
  while (start > 0 && session.messages[start - 1].role !== 'user') start--;
  const files = fileChanges(session.messages.slice(start));
  if (!files.length) return undefined;
  return {
    files,
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0),
  };
}
/** One line for running subagents: the freshest summary wins over the task description. */
export function subagentLine(session: Session) {
  const agents = session.subagents ?? [];
  if (!agents.length) return undefined;
  const latest = [...agents].reverse().find((a) => a.summary) ?? agents.at(-1)!;
  const text = (latest.summary || latest.description).replace(/\s+/g, ' ').trim();
  const count = agents.length === 1 ? 'Subagente' : `${agents.length} subagentes`;
  return text ? `${count} · ${text}` : count;
}
