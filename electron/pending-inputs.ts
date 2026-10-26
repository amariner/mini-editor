import { randomUUID } from 'node:crypto';
import type { Session } from '../src/shared';
import type { PreparedAttachment } from './attachments';

/** FIFO input buffer for runtimes that cannot accept another prompt yet. */
export class PendingInputs {
  private files = new Map<string, PreparedAttachment[]>();
  private delivering = new Set<string>();
  closed = false;
  constructor(
    private host: {
      sessions: () => Session[];
      ready: (s: Session) => boolean;
      send: (id: string, text: string, files: PreparedAttachment[]) => Promise<unknown>;
      changed: () => void;
    },
  ) {}
  enqueue(session: Session, text: string, files: PreparedAttachment[]) {
    const id = randomUUID();
    (session.pendingInputs ??= []).push({
      id,
      text,
      attachments: files.map((f) => f.attachment),
      status: 'pending',
    });
    this.files.set(id, files);
    this.host.changed();
    return true;
  }
  cancel(session: Session, id: string) {
    const item = session.pendingInputs?.find((p) => p.id === id);
    if (item?.status === 'sending') throw new Error('Este mensaje ya se está enviando.');
    session.pendingInputs = session.pendingInputs?.filter((p) => p.id !== id);
    this.files.delete(id);
    this.host.changed();
    return true;
  }
  pause(session: Session) {
    for (const item of session.pendingInputs ?? [])
      if (item.status === 'pending') {
        item.status = 'failed';
        item.error = 'Chat detenido. Recupera el mensaje para volver a enviarlo.';
        this.files.delete(item.id);
      }
  }
  pump() {
    if (this.closed) return;
    for (const session of this.host.sessions()) {
      if (this.delivering.has(session.id)) continue;
      const item = session.pendingInputs?.find((p) => p.status === 'pending');
      // Readiness may inspect runtime/MCP state; do it only for a queued message.
      if (!item || !this.host.ready(session)) continue;
      item.status = 'sending';
      this.delivering.add(session.id);
      void this.host
        .send(session.id, item.text, this.files.get(item.id) ?? [])
        .then(() => {
          session.pendingInputs = session.pendingInputs?.filter((p) => p !== item);
        })
        .catch((error) => {
          item.status = 'failed';
          item.error = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          this.files.delete(item.id);
          this.delivering.delete(session.id);
          this.host.changed();
        });
    }
  }
}
