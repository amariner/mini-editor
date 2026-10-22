/** Keep editing usable when storage is full or unavailable, without replacing sibling drafts. */
export function createDraftStorage(storage: () => Storage) {
  const cached = new Map<string, string>();
  const pending = new Map<string, { value: string | null; base: string | null | undefined }>();
  const diskValue = (key: string) => {
    try {
      return storage().getItem(key);
    } catch {
      return undefined;
    }
  };
  const remember = (key: string, value: string | null) => {
    if (value === null) cached.delete(key);
    else cached.set(key, value);
  };
  return {
    entries(prefix: string): [string, string][] {
      try {
        const source = storage();
        const stored = new Map<string, string>();
        for (let index = 0; index < source.length; index++) {
          const key = source.key(index);
          if (!key?.startsWith(prefix)) continue;
          const value = source.getItem(key);
          if (value !== null) stored.set(key, value);
        }
        for (const key of cached.keys()) if (key.startsWith(prefix)) cached.delete(key);
        for (const [key, value] of stored) cached.set(key, value);
        // Broadcast updates already persisted by another window need no memory override.
        for (const [key, item] of pending)
          if (key.startsWith(prefix) && (stored.get(key) ?? null) === item.value)
            pending.delete(key);
      } catch {
        // Keep the last readable snapshot and any more recent unsaved edits.
      }
      for (const [key, item] of pending) if (key.startsWith(prefix)) remember(key, item.value);
      return [...cached]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b));
    },
    write(key: string, value: string | null) {
      remember(key, value);
      try {
        if (value === null) storage().removeItem(key);
        else storage().setItem(key, value);
        pending.delete(key);
        return true;
      } catch {
        pending.set(key, { value, base: diskValue(key) });
        return false;
      }
    },
    receive(key: string, value: string | null) {
      remember(key, value);
      pending.set(key, { value, base: diskValue(key) });
    },
    refresh(key: string) {
      // StorageEvent.newValue may describe an old write. Read the current disk value,
      // preserving a newer fallback created after that same value was already on disk.
      const current = diskValue(key);
      if (current === undefined) return;
      const fallback = pending.get(key);
      if (fallback && fallback.base === current) return;
      pending.delete(key);
      remember(key, current);
    },
    clear() {
      cached.clear();
      pending.clear();
    },
  };
}
