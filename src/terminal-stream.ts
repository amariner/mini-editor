export type TerminalChunk = { data: string; sequence: number };

/** Reconcile live output with the initial snapshot exactly once, including failed snapshots. */
export function createTerminalStream(write: (data: string) => void) {
  let ready = false;
  let disposed = false;
  let pending: TerminalChunk[] = [];
  return {
    push(chunk: TerminalChunk) {
      if (disposed) return;
      if (ready) write(chunk.data);
      else pending.push(chunk);
    },
    restore(buffer?: TerminalChunk) {
      // A late snapshot after recovery must not replay output already shown.
      if (disposed || ready) return;
      ready = true;
      if (buffer?.data) write(buffer.data);
      for (const chunk of pending)
        if (!buffer || chunk.sequence > buffer.sequence) write(chunk.data);
      pending = [];
    },
    dispose() {
      disposed = true;
      pending = [];
    },
  };
}
