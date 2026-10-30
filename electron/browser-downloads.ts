import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserDownload } from '../src/browser-downloads';

const historyLimit = 200;
const activeLimit = 32;
type Entry = {
  state: BrowserDownload;
  item?: Electron.DownloadItem;
  target?: string;
  directory?: string;
  cleanup?: () => void;
};

/** Web-provided filenames never decide folders and cannot overwrite an existing download. */
export function downloadFilename(value: string) {
  const cleaned = value
    .normalize('NFC')
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  let result = cleaned || 'descarga';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result = `_${result}`;
  const extension = path.extname(result);
  const suffix = Buffer.byteLength(extension) <= 32 ? extension : '';
  const stem = Array.from(suffix ? result.slice(0, -suffix.length) : result);
  while (stem.length && Buffer.byteLength(stem.join('') + suffix) > 220) stem.pop();
  return (stem.join('') || 'descarga') + suffix;
}

function bytes(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Native Chromium downloads retain the tab's authenticated session. No file is auto-opened. */
export class BrowserDownloads {
  private entries = new Map<string, Entry>();
  private closed = false;
  private pendingChange?: NodeJS.Timeout;

  constructor(
    private root: string,
    private changed: () => void,
  ) {}

  private notify(immediate = false) {
    if (this.closed) return;
    if (immediate) {
      clearTimeout(this.pendingChange);
      this.pendingChange = undefined;
      this.changed();
    } else if (!this.pendingChange) {
      this.pendingChange = setTimeout(() => {
        this.pendingChange = undefined;
        if (!this.closed) this.changed();
      }, 200);
      this.pendingChange.unref();
    }
  }

  private trim() {
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= historyLimit) break;
      if (!entry.item) this.entries.delete(id);
    }
  }

  list(tabId?: string): BrowserDownload[] {
    return [...this.entries.values()]
      .filter((entry) => tabId === undefined || entry.state.tabId === tabId)
      .map((entry) => ({ ...entry.state }))
      .reverse();
  }

  handle(
    event: { preventDefault(): void },
    item: Electron.DownloadItem,
    _webContents: Electron.WebContents | undefined,
    tab: { id: string; projectId?: string; sessionId: string },
  ) {
    if (this.closed) {
      event.preventDefault();
      return;
    }
    const state: BrowserDownload = {
      id: randomUUID(),
      tabId: tab.id,
      projectId: tab.projectId,
      sessionId: tab.sessionId,
      fileName: downloadFilename(item.getFilename()),
      state: 'progress',
      receivedBytes: bytes(item.getReceivedBytes()),
      totalBytes: bytes(item.getTotalBytes()),
      startedAt: Date.now(),
      canResume: false,
    };
    const entry: Entry = { state };
    this.entries.set(state.id, entry);
    try {
      if ([...this.entries.values()].filter((entry) => entry.item).length >= activeLimit)
        throw new Error('Hay 32 descargas activas. Espera a que terminen o cancela alguna.');
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
      entry.directory = fs.realpathSync(fs.mkdtempSync(path.join(this.root, 'download-')));
      entry.target = path.join(entry.directory, state.fileName);
      item.setSavePath(entry.target);
      entry.item = item;
    } catch (error) {
      event.preventDefault();
      state.state = 'interrupted';
      state.error =
        error instanceof Error && error.message.startsWith('Hay 32')
          ? error.message
          : 'No se pudo preparar la descarga. Comprueba el espacio y el acceso a la carpeta de descargas.';
      if (entry.directory) {
        try {
          fs.rmdirSync(entry.directory);
        } catch {
          /* Do not delete any created file. */
        }
      }
      this.trim();
      this.notify(true);
      return { ...state };
    }
    const refresh = () => {
      state.receivedBytes = bytes(item.getReceivedBytes());
      state.totalBytes = bytes(item.getTotalBytes());
      state.canResume = item.canResume();
    };
    const updated = (_event: Electron.Event, status: 'progressing' | 'interrupted') => {
      if (!entry.item) return;
      refresh();
      state.state =
        status === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progress';
      state.error = status === 'interrupted' ? 'La descarga se ha interrumpido.' : undefined;
      this.notify();
    };
    const done = (_event: Electron.Event, status: 'completed' | 'cancelled' | 'interrupted') => {
      refresh();
      state.state = status;
      state.canResume = false;
      state.error =
        status === 'interrupted' ? 'La descarga se interrumpió. Vuelve a iniciarla.' : undefined;
      if (status === 'completed') {
        try {
          const info = fs.lstatSync(entry.target!);
          if (!info.isFile()) throw new Error('Not a regular file');
          state.path = entry.target;
          state.receivedBytes = info.size;
        } catch {
          state.state = 'interrupted';
          state.error =
            'Chromium terminó la descarga, pero el archivo guardado ya no está disponible.';
        }
      }
      entry.item = undefined;
      entry.cleanup?.();
      entry.cleanup = undefined;
      this.trim();
      this.notify(true);
    };
    item.on('updated', updated);
    item.once('done', done);
    entry.cleanup = () => {
      item.removeListener('updated', updated);
      item.removeListener('done', done);
    };
    this.trim();
    this.notify(true);
    return { ...state };
  }

  private entry(id: string, tabId: string) {
    const entry = this.entries.get(id);
    if (!entry || entry.state.tabId !== tabId)
      throw new Error('La descarga no pertenece a esta pestaña o ya no está disponible.');
    return entry;
  }

  cancel(id: string, tabId: string) {
    const entry = this.entry(id, tabId);
    if (!entry.item) return { ...entry.state };
    entry.item.cancel();
    entry.state.state = 'cancelled';
    entry.state.canResume = false;
    entry.state.error = undefined;
    this.notify(true);
    return { ...entry.state };
  }

  pause(id: string, tabId: string) {
    const entry = this.entry(id, tabId);
    if (!entry.item || entry.state.state !== 'progress')
      throw new Error('Esta descarga no está en curso.');
    entry.item.pause();
    entry.state.state = 'paused';
    entry.state.canResume = entry.item.canResume();
    this.notify(true);
    return { ...entry.state };
  }

  resume(id: string, tabId: string) {
    const entry = this.entry(id, tabId);
    if (
      !entry.item ||
      !['paused', 'interrupted'].includes(entry.state.state) ||
      !entry.item.canResume()
    )
      throw new Error('Esta descarga no puede reanudarse. Vuelve a iniciarla desde la página.');
    entry.item.resume();
    entry.state.state = 'progress';
    entry.state.canResume = false;
    entry.state.error = undefined;
    this.notify(true);
    return { ...entry.state };
  }

  async revealPath(id: string, tabId: string) {
    const entry = this.entry(id, tabId);
    if (entry.state.state !== 'completed' || !entry.state.path)
      throw new Error('Espera a que termine la descarga para mostrar el archivo.');
    try {
      const info = await fs.promises.lstat(entry.state.path);
      if (!info.isFile()) throw new Error('Not a regular file');
      const actual = await fs.promises.realpath(entry.state.path);
      if (path.dirname(actual) !== entry.directory) throw new Error('Directory changed');
      return actual;
    } catch {
      throw new Error('El archivo descargado se ha movido o eliminado.');
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.pendingChange);
    this.pendingChange = undefined;
    for (const entry of this.entries.values()) {
      if (!entry.item) continue;
      entry.cleanup?.();
      entry.cleanup = undefined;
      try {
        entry.item.cancel();
      } catch {
        /* Already closed by Chromium. */
      }
      entry.item = undefined;
      entry.state.state = 'cancelled';
      entry.state.canResume = false;
    }
  }
}
