import { useMemo, useSyncExternalStore } from 'react';
import type { Session } from './shared';
import { createDraftStorage } from './draft-storage';
import {
  CHAT_ORDER_PREFIX,
  chatOrderGroup,
  moveChatInOrder,
  parseChatOrder,
  reconcileChatOrder,
  type ChatOrderEdge,
} from './chat-order';

const storage = createDraftStorage(() => localStorage);
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
let snapshot = JSON.stringify(storage.entries(CHAT_ORDER_PREFIX));
const refresh = () => {
  snapshot = JSON.stringify(storage.entries(CHAT_ORDER_PREFIX));
};
const read = () => snapshot;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
window.addEventListener('storage', (event) => {
  if (event.key === null) storage.clear();
  else if (event.key.startsWith(CHAT_ORDER_PREFIX)) storage.refresh(event.key);
  else return;
  refresh();
  notify();
});

export function useChatOrder(sessions: readonly Session[]) {
  const snapshot = useSyncExternalStore(subscribe, read);
  // Streamed message/status changes do not rebuild the ordering preference.
  const identities = JSON.stringify(
    sessions.map(({ id, projectId, parentId }) => ({ id, projectId, parentId })),
  );
  const order = useMemo(
    () => reconcileChatOrder(JSON.parse(identities), parseChatOrder(JSON.parse(snapshot))),
    [identities, snapshot],
  );
  const move = (sourceId: string, targetId: string, edge: ChatOrderEdge) => {
    // Read again at commit so an update from another window is not overwritten.
    const current = reconcileChatOrder(
      sessions,
      parseChatOrder(storage.entries(CHAT_ORDER_PREFIX)),
    );
    const next = moveChatInOrder(current, sessions, sourceId, targetId, edge);
    if (next === current) return false;
    const source = sessions.find((chat) => chat.id === sourceId)!;
    const group = chatOrderGroup(source);
    // One key per sibling group preserves unrelated ordering in other windows/projects.
    storage.write(CHAT_ORDER_PREFIX + group, JSON.stringify(next[group]));
    refresh();
    notify();
    return true;
  };
  return { order, move };
}
