import type { Session } from './shared';

export type ChatOrder = Record<string, string[]>;
type Chat = Pick<Session, 'id' | 'projectId' | 'parentId'>;
export type ChatOrderEdge = 'before' | 'after';
export const CHAT_ORDER_PREFIX = 'agent-desk.chat-order.v1:';

/** Children move with their parent; only siblings share a saved order. */
export function chatOrderGroup(chat: Chat): string {
  return JSON.stringify(chat.parentId ? ['children', chat.parentId] : ['project', chat.projectId]);
}

export function parseChatOrder(entries: readonly (readonly [string, string])[]): ChatOrder {
  const result: ChatOrder = {};
  for (const [key, value] of entries) {
    if (!key.startsWith(CHAT_ORDER_PREFIX)) continue;
    try {
      const group: unknown = JSON.parse(key.slice(CHAT_ORDER_PREFIX.length));
      const ids: unknown = JSON.parse(value);
      if (
        !Array.isArray(group) ||
        group.length !== 2 ||
        !['project', 'children'].includes(group[0]) ||
        typeof group[1] !== 'string' ||
        !Array.isArray(ids) ||
        !ids.every((id) => typeof id === 'string')
      )
        continue;
      result[JSON.stringify(group)] = [...new Set(ids)];
    } catch {
      // An old or malformed UI preference must never hide a conversation.
    }
  }
  return result;
}

/** Snapshot insertion order is oldest first. New chats always precede saved positions. */
export function reconcileChatOrder(chats: readonly Chat[], saved: ChatOrder): ChatOrder {
  const groups: ChatOrder = {};
  for (const chat of [...chats].reverse()) (groups[chatOrderGroup(chat)] ??= []).push(chat.id);
  for (const [group, ids] of Object.entries(groups)) {
    const available = new Set(ids);
    const previous = [...new Set(saved[group] ?? [])].filter((id) => available.has(id));
    const known = new Set(previous);
    groups[group] = [...ids.filter((id) => !known.has(id)), ...previous];
  }
  return groups;
}

export function orderSiblingChats<T extends Chat>(chats: readonly T[], order: ChatOrder): T[] {
  const byId = new Map(chats.map((chat) => [chat.id, chat]));
  const result: T[] = [];
  const seen = new Set<string>();
  const seenGroups = new Set<string>();
  // Usually there is a single group. Hidden/missing parents can expose several roots.
  for (const chat of [...chats].reverse()) {
    const group = chatOrderGroup(chat);
    if (!seenGroups.has(group)) {
      seenGroups.add(group);
      for (const id of order[group] ?? []) {
        const sibling = byId.get(id);
        if (!sibling || seen.has(id)) continue;
        seen.add(id);
        result.push(sibling);
      }
    }
    if (!seen.has(chat.id)) {
      seen.add(chat.id);
      result.push(chat);
    }
  }
  return result;
}

export function moveChatInOrder(
  order: ChatOrder,
  chats: readonly Chat[],
  sourceId: string,
  targetId: string,
  edge: ChatOrderEdge,
): ChatOrder {
  if (sourceId === targetId) return order;
  const source = chats.find((chat) => chat.id === sourceId);
  const target = chats.find((chat) => chat.id === targetId);
  if (!source || !target || chatOrderGroup(source) !== chatOrderGroup(target)) return order;
  const group = chatOrderGroup(source);
  const previous = order[group] ?? [];
  if (!previous.includes(sourceId) || !previous.includes(targetId)) return order;
  const next = previous.filter((id) => id !== sourceId);
  next.splice(next.indexOf(targetId) + (edge === 'after' ? 1 : 0), 0, sourceId);
  if (next.every((id, index) => id === previous[index])) return order;
  return { ...order, [group]: next };
}

/** Dropdowns share the sidebar's hierarchy, with each sibling group ordered independently. */
export function orderedProjectChats<T extends Chat>(
  chats: readonly T[],
  projectId: string,
  order: ChatOrder,
): T[] {
  const project = chats.filter((chat) => chat.projectId === projectId);
  const projectIds = new Set(project.map((chat) => chat.id));
  const result: T[] = [];
  const seen = new Set<string>();
  const children = new Map<string, T[]>();
  for (const chat of project) {
    if (!chat.parentId) continue;
    const siblings = children.get(chat.parentId) ?? [];
    siblings.push(chat);
    children.set(chat.parentId, siblings);
  }
  const visit = (siblings: readonly T[]) => {
    for (const chat of orderSiblingChats(siblings, order)) {
      if (seen.has(chat.id)) continue;
      seen.add(chat.id);
      result.push(chat);
      visit(children.get(chat.id) ?? []);
    }
  };
  visit(project.filter((chat) => !chat.parentId || !projectIds.has(chat.parentId)));
  // Keep malformed cyclic/orphaned historical data selectable too.
  visit(project.filter((chat) => !seen.has(chat.id)));
  return result;
}
