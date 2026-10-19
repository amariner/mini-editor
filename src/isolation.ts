import { isConnectedProvider, providerKind, type Session } from './shared';
import { sessionIsLive } from './session-tabs';

type Chat = Pick<Session, 'id' | 'projectId' | 'profile' | 'status' | 'isolation' | 'worktree'> &
  Partial<Pick<Session, 'attempted' | 'forkFrom' | 'mode'>>;

/** Worktree isolation is implemented for Claude Code chats and its official terminal. */
export const canIsolate = (s: Pick<Session, 'profile'>) =>
  providerKind(s.profile) === 'claude' && !isConnectedProvider(s.profile);

/** Other agents running in the same project folder (not in their own worktree). */
export const liveNeighbours = (s: Chat, sessions: Chat[]) =>
  sessions.filter((o) => o.id !== s.id && o.projectId === s.projectId && sessionIsLive(o));

/**
 * Whether the next start runs in a worktree. Explicit choices win; otherwise a new chat isolates
 * itself when another agent is already alive in the project. A started chat keeps its folder.
 */
export function wantsWorktree(s: Chat, sessions: Chat[]) {
  if (!canIsolate(s)) return false;
  if (s.worktree) return true;
  if (s.isolation) return s.isolation === 'worktree';
  if (s.attempted && !s.forkFrom) return false;
  return liveNeighbours(s, sessions).length > 0;
}

/** The isolation choice can change until the chat has a worktree or has run in the folder. */
export const isolationLocked = (s: Chat) => !!s.worktree || (!!s.attempted && !s.forkFrom);
