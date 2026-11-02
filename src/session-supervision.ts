import type { Session, Status } from './shared';

export type TurnOutcome = 'completed' | 'interrupted' | 'failed';
export interface SessionSupervision {
  revision: number;
  seenRevision: number;
  startedAt: number;
  finishedAt?: number;
  outcome?: TurnOutcome;
}
/** The host owns progress and read positions; each window only acknowledges what it shows. */
export function observeSession(session: Session, previous?: Status, now = Date.now()) {
  if (session.mode === 'terminal' || session.status === 'terminal') return;
  const turn = session.supervision;
  if (
    session.status === 'working' &&
    previous !== 'working' &&
    previous !== 'waiting' &&
    (!turn || turn.finishedAt)
  ) {
    session.supervision = {
      revision: (turn?.revision ?? 0) + 1,
      seenRevision: turn?.seenRevision ?? 0,
      startedAt: now,
    };
  } else if (turn && !turn.finishedAt && ['ready', 'stopped', 'error'].includes(session.status)) {
    turn.finishedAt = now;
    turn.outcome ??=
      session.error || session.status === 'error'
        ? 'failed'
        : session.status === 'stopped'
          ? 'interrupted'
          : 'completed';
  }
}
export function finishSession(session: Session, outcome: TurnOutcome, now = Date.now()) {
  if (!session.supervision || session.supervision.finishedAt) return;
  session.supervision.outcome = outcome;
  session.supervision.finishedAt = now;
}
export function markSessionRead(session: Session, revision: number) {
  const turn = session.supervision;
  // Never acknowledge a later revision from an old or malformed renderer request.
  if (!turn?.finishedAt || revision !== turn.revision || turn.seenRevision >= revision)
    return false;
  turn.seenRevision = revision;
  return true;
}
export const hasUnreadTurn = (session: Session) =>
  !!session.supervision?.finishedAt &&
  session.supervision.revision > session.supervision.seenRevision;

export interface AgentDelivery {
  id: string;
  description: string;
  summary?: string;
  tool?: string;
  outcome: TurnOutcome;
  finishedAt: number;
}
export function recordAgentDelivery(
  session: Session,
  id: string,
  status: string,
  summary?: string,
) {
  const agent = session.subagents?.find((a) => a.id === id);
  const prior = session.agentDeliveries?.find((a) => a.id === id);
  if (!agent && !prior) return; // Shell tasks are tracked separately.
  const outcome: TurnOutcome =
    status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'interrupted';
  session.agentDeliveries = [
    ...(session.agentDeliveries ?? []).filter((a) => a.id !== id),
    {
      ...prior,
      ...agent,
      id,
      description: agent?.description ?? prior!.description,
      summary: summary?.slice(0, 6000) || prior?.summary || agent?.summary,
      outcome,
      finishedAt: prior?.finishedAt ?? Date.now(),
    },
  ].slice(-40);
}
