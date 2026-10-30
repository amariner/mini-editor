import { randomUUID } from 'node:crypto';
import type { BrowserDialog } from '../src/browser-dialogs';

type DialogResult = { dialog: BrowserDialog };
type NativeDialog = {
  dialogType: 'alert' | 'confirm' | 'prompt';
  messageText: string;
  defaultPromptText?: string;
  frame?: { url?: string };
};

/**
 * Owns native alert/confirm callbacks and the narrow preload prompt bridge.
 * Electron 45's default main-process handler opens a blocking OS sheet and rejects
 * prompt(). This per-WebContents adapter replaces that handler and restores it on
 * disposal. The version-specific event is covered by browser-dialogs-check.mjs.
 * Source: electron v45.1.0 lib/browser/api/web-contents.ts, '-run-dialog'.
 */
export class BrowserDialogs {
  current?: BrowserDialog;
  readonly supported: boolean;
  private disposed = false;
  private events: NodeJS.EventEmitter;
  private callback?: (accept: boolean, text: string) => void;
  private ipcPrompt = false;
  private originalHandlers: ((...args: any[]) => void)[];
  private waiters = new Set<{
    resolve: (result: DialogResult) => void;
    reject: (error: Error) => void;
  }>();

  constructor(
    private wc: Electron.WebContents,
    private changed: (dialog?: BrowserDialog) => void,
  ) {
    this.events = wc as NodeJS.EventEmitter;
    this.originalHandlers = (
      this.events.listeners('-run-dialog') as ((...args: any[]) => void)[]
    ).filter(
      (handler) => /showMessageBox/.test(String(handler)) && /dialogType/.test(String(handler)),
    );
    this.supported = this.originalHandlers.length === 1;
    // The preload prompt replacement must always have a reply handler, including
    // when a newer Electron version needs its native alert/confirm fallback.
    this.events.on('-cancel-dialogs', this.cancelled);
    this.events.on('ipc-message-sync', this.promptRequest);
    this.events.on('render-process-gone', this.cancelled);
    this.events.once('destroyed', this.destroyed);
    // Future Electron releases may change the internal hook. Preserve their native
    // behavior if its expected built-in implementation cannot be identified.
    if (!this.supported) {
      this.originalHandlers = [];
      return;
    }
    for (const handler of this.originalHandlers) this.events.removeListener('-run-dialog', handler);
    this.events.on('-run-dialog', this.runDialog);
  }

  // Retained as harmless compatibility points for the browser action lifecycle.
  // The native callback adapter no longer requires a persistent CDP attachment.
  attach() {}
  async ready() {}

  private promptRequest = (
    event: Electron.IpcMainEvent,
    channel: string,
    message: unknown,
    initial: unknown,
  ) => {
    if (channel !== 'agent-desk:browser-prompt') return;
    if (
      this.disposed ||
      event.sender !== this.wc ||
      !event.senderFrame ||
      typeof message !== 'string' ||
      typeof initial !== 'string' ||
      message.length > 5000 ||
      initial.length > 20000
    ) {
      event.returnValue = null;
      return;
    }
    const previous = this.callback;
    this.runDialog(
      {
        dialogType: 'prompt',
        messageText: message,
        defaultPromptText: initial,
        frame: { url: event.senderFrame.url },
      },
      (accept, text) => {
        event.returnValue = accept ? text : null;
      },
    );
    if (!previous && this.callback) this.ipcPrompt = true;
  };

  private runDialog = (info: NativeDialog, callback: (accept: boolean, text: string) => void) => {
    if (this.disposed || !['alert', 'confirm', 'prompt'].includes(info.dialogType)) {
      callback(false, '');
      return;
    }
    // Chromium serializes dialogs per renderer. Defend against malformed/reentrant
    // event delivery without silently accepting either request.
    if (this.callback) {
      callback(false, '');
      return;
    }
    this.callback = callback;
    this.current = {
      id: randomUUID(),
      type: info.dialogType,
      message: String(info.messageText ?? '').slice(0, 5000),
      url: String(info.frame?.url ?? '').slice(0, 4096),
      ...(info.dialogType === 'prompt'
        ? { defaultPrompt: String(info.defaultPromptText ?? '').slice(0, 20000) }
        : {}),
    };
    this.changed(this.current);
    for (const waiter of this.waiters) waiter.resolve({ dialog: this.current });
  };

  private cancelled = () => {
    // Chromium already resolves native dialog cancellation. The separate preload
    // prompt IPC still needs a null reply to release the synchronous renderer call.
    const callback = this.callback;
    const ipcPrompt = this.ipcPrompt;
    this.callback = undefined;
    this.ipcPrompt = false;
    if (ipcPrompt) {
      try {
        callback?.(false, '');
      } catch {
        /* The requesting frame may already be gone. */
      }
    }
    if (this.current) {
      this.current = undefined;
      this.changed();
    }
  };
  private destroyed = () => this.dispose();

  /** A click can block until answered. Return its prompt without blocking the caller. */
  async race<T>(operation: Promise<T>): Promise<T | DialogResult> {
    if (this.disposed) {
      void operation.catch(() => {});
      throw new Error('La pestaña se ha cerrado.');
    }
    if (this.current) {
      void operation.catch(() => {});
      return { dialog: this.current };
    }
    let resolve!: (result: DialogResult) => void;
    let reject!: (error: Error) => void;
    const opened = new Promise<DialogResult>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const waiter = { resolve, reject };
    this.waiters.add(waiter);
    try {
      return await Promise.race([operation, opened]);
    } finally {
      this.waiters.delete(waiter);
    }
  }

  async respond(id: string, accept: boolean, promptText?: string) {
    const dialog = this.current;
    if (!dialog || dialog.id !== id || !this.callback)
      throw new Error('El diálogo ya no está abierto. Inspecciona de nuevo la pestaña.');
    if (typeof accept !== 'boolean') throw new Error('Indica si aceptas o cancelas el diálogo.');
    if (promptText !== undefined && (typeof promptText !== 'string' || promptText.length > 20000))
      throw new Error('La respuesta del diálogo supera el límite permitido.');
    if (promptText !== undefined && dialog.type !== 'prompt')
      throw new Error('Este diálogo no admite una respuesta de texto.');
    const callback = this.callback;
    this.callback = undefined;
    this.ipcPrompt = false;
    this.current = undefined;
    this.changed();
    callback(
      accept,
      accept && dialog.type === 'prompt' ? (promptText ?? dialog.defaultPrompt ?? '') : '',
    );
    return { ok: true, ...(this.current ? { dialog: this.current } : {}) };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.events.removeListener('-run-dialog', this.runDialog);
    this.events.removeListener('-cancel-dialogs', this.cancelled);
    this.events.removeListener('ipc-message-sync', this.promptRequest);
    this.events.removeListener('render-process-gone', this.cancelled);
    this.events.removeListener('destroyed', this.destroyed);
    for (const waiter of this.waiters) waiter.reject(new Error('La pestaña se ha cerrado.'));
    this.waiters.clear();
    if (!this.wc.isDestroyed()) {
      const callback = this.callback;
      this.callback = undefined;
      callback?.(false, '');
      for (const handler of this.originalHandlers) this.events.on('-run-dialog', handler);
    }
    this.originalHandlers = [];
    this.cancelled();
  }
}
