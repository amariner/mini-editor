import { useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import type { Attachment } from './shared';

const textPrefix = 'agent-desk.chat-draft.v1:';
const imagePrefix = 'agent-desk.chat-attachment.v1:';
function entries(prefix: string): [string, string][] {
  return Object.keys(localStorage)
    .filter((key) => key.startsWith(prefix))
    .sort()
    .map((key) => [key.slice(prefix.length), localStorage.getItem(key)!]);
}

// One synchronous storage entry per chat: simultaneous edits in different native
// windows never replace a sibling's draft. OS window closure needs no async flush.
function sharedDrafts<T>(prefix: string) {
  let raw = '';
  let value: Record<string, T> = {};
  const listeners = new Set<() => void>();
  const read = () => {
    const stored = entries(prefix);
    const serialized = JSON.stringify(stored);
    if (serialized !== raw) {
      raw = serialized;
      value = {};
      for (const [id, item] of stored) {
        try {
          value[id] = JSON.parse(item);
        } catch {
          /* Ignore malformed local drafts. */
        }
      }
    }
    return value;
  };
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key.startsWith(prefix)) listeners.forEach((fn) => fn());
  });
  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  };
  const update: Dispatch<SetStateAction<Record<string, T>>> = (action) => {
    const current = read();
    const next = typeof action === 'function' ? action(current) : action;
    if (current === next) return;
    for (const id of new Set([...Object.keys(current), ...Object.keys(next)])) {
      if (current[id] === next[id]) continue;
      if (next[id] === undefined) localStorage.removeItem(prefix + id);
      else localStorage.setItem(prefix + id, JSON.stringify(next[id]));
    }
    read();
    listeners.forEach((fn) => fn());
  };
  return () => [useSyncExternalStore(subscribe, read), update] as const;
}

export const useTextDrafts = sharedDrafts<string>(textPrefix);
export const useImageDrafts = sharedDrafts<Attachment[]>(imagePrefix);

// Attachment handles live in the main process and expire at application exit.
// Preserve text across launches, but never resurrect unusable attachment handles.
export function initializeDraftLifetime(instanceId?: string) {
  if (!instanceId || localStorage.getItem('agent-desk.draft-lifetime') === instanceId) return;
  for (const [id] of entries(imagePrefix)) localStorage.removeItem(imagePrefix + id);
  localStorage.setItem('agent-desk.draft-lifetime', instanceId);
  window.dispatchEvent(new StorageEvent('storage', { key: null }));
}
