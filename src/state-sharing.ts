import type { Message, Session, Snapshot } from './shared';

// IPC creates new objects for every broadcast. Compare data without serializing large
// tool results again, then retain unchanged identities for memoized conversation rows.
function equalData(left: unknown, right: unknown): boolean {
  const pending: [unknown, unknown][] = [[left, right]];
  while (pending.length) {
    const [a, b] = pending.pop()!;
    if (Object.is(a, b)) continue;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && a.length !== (b as unknown[]).length) return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      const leftValue = (a as Record<string, unknown>)[key];
      const rightValue = (b as Record<string, unknown>)[key];
      if (Object.is(leftValue, rightValue)) continue;
      if (
        !leftValue ||
        !rightValue ||
        typeof leftValue !== 'object' ||
        typeof rightValue !== 'object'
      )
        return false;
      pending.push([leftValue, rightValue]);
    }
  }
  return true;
}
function shareMessages(previous: Message[], incoming: Message[]): Message[] {
  const byId = new Map(previous.map((message) => [message.id, message]));
  const shared = incoming.map((message) => {
    const before = byId.get(message.id);
    return before && equalData(before, message) ? before : message;
  });
  return shared.length === previous.length && shared.every((message, i) => message === previous[i])
    ? previous
    : shared;
}
function shareSession(previous: Session, incoming: Session): Session {
  const shared = { ...incoming, messages: shareMessages(previous.messages, incoming.messages) };
  for (const key of Object.keys(shared) as (keyof Session)[]) {
    if (key !== 'messages' && equalData(previous[key], shared[key])) {
      // Every value comes from the same field of the same session.
      (shared as Record<string, unknown>)[key] = previous[key];
    }
  }
  const keys = Object.keys(shared) as (keyof Session)[];
  return keys.length === Object.keys(previous).length &&
    keys.every(
      (key) => Object.prototype.hasOwnProperty.call(previous, key) && shared[key] === previous[key],
    )
    ? previous
    : shared;
}
/** Reuse unchanged IPC data without mutating either snapshot or retaining old revisions. */
export function reconcileSnapshot(previous: Snapshot | undefined, incoming: Snapshot): Snapshot {
  if (!previous || previous === incoming) return incoming;
  const sessions = new Map(previous.sessions.map((session) => [session.id, session]));
  const sharedSessions = incoming.sessions.map((session) => {
    const before = sessions.get(session.id);
    return before ? shareSession(before, session) : session;
  });
  const shared = {
    ...incoming,
    sessions:
      sharedSessions.length === previous.sessions.length &&
      sharedSessions.every((session, i) => session === previous.sessions[i])
        ? previous.sessions
        : sharedSessions,
  };
  for (const key of Object.keys(shared) as (keyof Snapshot)[]) {
    if (key !== 'sessions' && equalData(previous[key], shared[key]))
      (shared as Record<string, unknown>)[key] = previous[key];
  }
  const keys = Object.keys(shared) as (keyof Snapshot)[];
  return keys.length === Object.keys(previous).length &&
    keys.every(
      (key) => Object.prototype.hasOwnProperty.call(previous, key) && shared[key] === previous[key],
    )
    ? previous
    : shared;
}
