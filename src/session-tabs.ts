import type { Session } from './shared';

export const MAX_SESSION_TABS = 5;
export const sessionGroup = (s: Pick<Session, 'projectId' | 'profile'>) =>
  `${s.projectId}:${s.profile}`;
export const sessionIsLive = (s?: Pick<Session, 'status'>) =>
  !!s && ['starting', 'terminal', 'ready', 'working', 'waiting', 'stopping'].includes(s.status);

// Order is MRU for eviction, but existing tabs retain their visual position in the UI.
export function openSessionTab(ids: string[], selected: Session, sessions: Session[]): string[] {
  const group = sessions.filter((s) => sessionGroup(s) === sessionGroup(selected));
  const next = ids.filter((id) => id !== selected.id && group.some((s) => s.id === id));
  next.push(selected.id);
  while (next.length > MAX_SESSION_TABS) {
    const oldest = next.findIndex(
      (id) => id !== selected.id && !sessionIsLive(group.find((s) => s.id === id)),
    );
    if (oldest < 0) break; // Never silently stop or hide a live process.
    next.splice(oldest, 1);
  }
  return next;
}
