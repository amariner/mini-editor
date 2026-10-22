import { useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import type { Attachment } from './shared';
import { createDraftStorage } from './draft-storage';

const textPrefix = 'agent-desk.chat-draft.v1:';
const imagePrefix = 'agent-desk.chat-attachment.v1:';
const storage = createDraftStorage(() => localStorage);
const changes = new Set<() => void>();
const notify = () => changes.forEach((fn) => fn());
const isDraft = (key: string) => key.startsWith(textPrefix) || key.startsWith(imagePrefix);
let channel: BroadcastChannel | undefined;
let warned = false;
try {
  channel = new BroadcastChannel('agent-desk.drafts.v1');
  channel.onmessage = ({ data }) => {
    if (
      !data ||
      typeof data.key !== 'string' ||
      !isDraft(data.key) ||
      (data.value !== null && typeof data.value !== 'string')
    )
      return;
    storage.receive(data.key, data.value);
    notify();
  };
} catch {
  // Storage events still synchronize windows when BroadcastChannel is unavailable.
}
window.addEventListener('storage', (event) => {
  if (event.key === null) storage.clear();
  else if (isDraft(event.key)) storage.refresh(event.key);
  else return;
  notify();
});
const write = (key: string, value: string | null) => {
  if (!storage.write(key, value)) {
    try {
      channel?.postMessage({ key, value });
    } catch {
      /* Keep the local draft. */
    }
    if (!warned) {
      warned = true;
      window.dispatchEvent(new Event('agent-desk:draft-storage-error'));
    }
  }
};
function entries(prefix: string): [string, string][] {
  return storage.entries(prefix).map(([key, value]) => [key.slice(prefix.length), value]);
}

// One synchronous storage entry per chat: simultaneous edits in different native
// windows never replace a sibling's draft. OS window closure needs no async flush.
function sharedDrafts<T>(prefix: string, valid: (value: unknown) => value is T) {
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
          const parsed: unknown = JSON.parse(item);
          if (valid(parsed)) value[id] = parsed;
        } catch {
          /* Ignore malformed local drafts. */
        }
      }
    }
    return value;
  };
  changes.add(() => listeners.forEach((fn) => fn()));
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
      write(prefix + id, next[id] === undefined ? null : JSON.stringify(next[id]));
    }
    read();
    listeners.forEach((fn) => fn());
  };
  return () => [useSyncExternalStore(subscribe, read), update] as const;
}

export const useTextDrafts = sharedDrafts<string>(
  textPrefix,
  (value): value is string => typeof value === 'string',
);
export const useImageDrafts = sharedDrafts<Attachment[]>(
  imagePrefix,
  (value): value is Attachment[] =>
    Array.isArray(value) &&
    value.every((item) => item && typeof item.id === 'string' && typeof item.name === 'string'),
);

// Attachment handles live in the main process and expire at application exit.
// Preserve text across launches, but never resurrect unusable attachment handles.
export function initializeDraftLifetime(instanceId?: string) {
  const lifetimeKey = 'agent-desk.draft-lifetime';
  if (
    !instanceId ||
    storage.entries(lifetimeKey).find(([key]) => key === lifetimeKey)?.[1] === instanceId
  )
    return;
  for (const [id] of entries(imagePrefix)) write(imagePrefix + id, null);
  storage.write(lifetimeKey, instanceId);
  notify();
}
