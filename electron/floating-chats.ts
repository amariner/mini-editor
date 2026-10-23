import { BrowserWindow, screen, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  floatingChatHash,
  MIN_FLOATING_OPACITY,
  type FloatingChatState,
} from '../src/floating-chat-protocol';
import type { DeskEvent, Session } from '../src/shared';

type Preferences = Omit<FloatingChatState, 'sessionId' | 'glassSupported'> & {
  bounds?: Electron.Rectangle;
};
type Entry = { window: BrowserWindow; preferences: Preferences; ready: boolean };

/** Native, independent windows; closing one never touches the agent's lifecycle. */
export class FloatingChats {
  private entries = new Map<string, Entry>();
  private preferences: Record<string, Preferences> = {};
  private file: string;
  private hiddenForEditor = false;
  private revealing = false;
  private saveTimer?: ReturnType<typeof setTimeout>;

  constructor(
    dataDir: string,
    private dev: string | undefined,
    private changed: () => void,
    private parent: () => BrowserWindow | undefined,
  ) {
    this.file = path.join(dataDir, 'floating-chats.json');
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) this.preferences = saved;
    } catch {}
  }

  private savePreferences(immediate = false) {
    clearTimeout(this.saveTimer);
    const write = () => {
      this.saveTimer = undefined;
      try {
        fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.preferences));
        fs.renameSync(this.file + '.tmp', this.file);
      } catch {}
    };
    if (immediate) write();
    else {
      this.saveTimer = setTimeout(write, 150);
      this.saveTimer.unref();
    }
  }

  private url(id: string) {
    return (
      (this.dev ? `${this.dev}/` : pathToFileURL(path.join(__dirname, '../dist/index.html')).href) +
      floatingChatHash(id)
    );
  }

  owner(contents: WebContents) {
    for (const [id, entry] of this.entries)
      if (!entry.window.isDestroyed() && entry.window.webContents === contents) return id;
    return undefined;
  }

  trusted(contents: WebContents, url: string) {
    const id = this.owner(contents);
    return !!id && url === this.url(id);
  }

  snapshot(): FloatingChatState[] {
    return [...this.entries].map(([sessionId, { preferences }]) => ({
      sessionId,
      opacity: preferences.opacity,
      alwaysOnTop: preferences.alwaysOnTop,
      glass: preferences.glass,
      blur: preferences.blur ?? false,
      glassStrength: preferences.glassStrength ?? 1,
      glassSupported: process.platform === 'darwin',
    }));
  }

  broadcast(event: DeskEvent) {
    for (const { window } of this.entries.values())
      if (!window.isDestroyed()) window.webContents.send('desk:event', event);
  }

  reconcile(sessions: Session[]) {
    for (const [id, entry] of this.entries) {
      const session = sessions.find((s) => s.id === id);
      if (!session) entry.window.close();
      else entry.window.setTitle(`${session.title} · Agent Desk`);
    }
    const ids = new Set(sessions.map((s) => s.id));
    const removed = Object.keys(this.preferences).filter((id) => !ids.has(id));
    if (removed.length) {
      for (const id of removed) delete this.preferences[id];
      this.savePreferences(true);
    }
  }

  hideForEditor() {
    if (this.revealing) return;
    this.hiddenForEditor = true;
    for (const { window } of this.entries.values())
      if (!window.isDestroyed() && window.isVisible()) window.hide();
  }

  restoreAfterEditor() {
    const editor = this.parent();
    if (!this.hiddenForEditor || (editor && !editor.isDestroyed() && editor.isFocused())) return;
    this.showAll();
  }

  // Showing siblings must not activate the editor or steal focus from another app.
  private showAll(target?: BrowserWindow) {
    if (this.revealing) return;
    this.revealing = true;
    this.hiddenForEditor = false;
    try {
      for (const { window, ready } of this.entries.values()) {
        if (!ready || window.isDestroyed()) continue;
        if (target && window.isMinimized()) window.restore();
        if (!window.isMinimized() && !window.isVisible()) window.showInactive();
      }
      if (target && !target.isDestroyed()) {
        target.show();
        target.focus();
      }
    } finally {
      this.revealing = false;
    }
  }

  async open(session: Session) {
    const existing = this.entries.get(session.id);
    if (existing) {
      this.focus(session.id);
      return;
    }
    const saved = this.preferences[session.id];
    const candidate = saved?.bounds;
    const bounds =
      candidate &&
      ['x', 'y', 'width', 'height'].every((key) =>
        Number.isFinite(candidate[key as keyof Electron.Rectangle]),
      ) &&
      candidate.width > 0 &&
      candidate.height > 0
        ? {
            x: Math.round(candidate.x),
            y: Math.round(candidate.y),
            width: Math.round(candidate.width),
            height: Math.round(candidate.height),
          }
        : undefined;
    const display = screen.getDisplayMatching(
      bounds ?? this.parent()?.getBounds() ?? { x: 0, y: 0, width: 480, height: 640 },
    ).workArea;
    const width = Math.min(display.width, Math.max(340, bounds?.width ?? 460));
    const height = Math.min(display.height, Math.max(360, bounds?.height ?? 660));
    const offset = (this.entries.size % 8) * 28;
    const x = Math.round(
      Math.max(
        display.x,
        Math.min(
          bounds ? bounds.x : display.x + display.width - width - 24 - offset,
          display.x + display.width - width,
        ),
      ),
    );
    const y = Math.round(
      Math.max(
        display.y,
        Math.min(bounds ? bounds.y : display.y + 64 + offset, display.y + display.height - height),
      ),
    );
    const preferences: Preferences = {
      opacity: Number.isFinite(saved?.opacity)
        ? Math.max(MIN_FLOATING_OPACITY, Math.min(1, saved.opacity))
        : 1,
      alwaysOnTop: typeof saved?.alwaysOnTop === 'boolean' ? saved.alwaysOnTop : true,
      glass: typeof saved?.glass === 'boolean' ? saved.glass : true,
      blur: typeof saved?.blur === 'boolean' ? saved.blur : false,
      glassStrength: Number.isFinite(saved?.glassStrength)
        ? Math.max(0, Math.min(2, saved.glassStrength!))
        : 1,
    };
    const window = new BrowserWindow({
      x,
      y,
      width,
      height,
      minWidth: 340,
      minHeight: 360,
      title: `${session.title} · Agent Desk`,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      // Clip the native material too, so it cannot spill into transparent corners.
      roundedCorners: true,
      ...(process.platform === 'darwin'
        ? {
            vibrancy: preferences.blur ? ('under-window' as const) : undefined,
            visualEffectState: 'active' as const,
          }
        : {}),
      resizable: true,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      show: false,
      alwaysOnTop: preferences.alwaysOnTop,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const entry = { window, preferences, ready: false };
    this.entries.set(session.id, entry);
    window.setAlwaysOnTop(preferences.alwaysOnTop, 'floating');
    if (process.platform === 'darwin')
      window.setVisibleOnAllWorkspaces(preferences.alwaysOnTop, { visibleOnFullScreen: true });
    const remember = () => {
      if (!window.isDestroyed()) preferences.bounds = window.getBounds();
      this.preferences[session.id] = preferences;
      // A broken preferences file must not prevent a window from closing.
      this.savePreferences(true);
    };
    window.on('moved', remember);
    window.on('resized', remember);
    window.on('focus', () => this.showAll());
    window.on('close', () => {
      remember();
      this.savePreferences(true);
    });
    window.on('closed', () => {
      this.entries.delete(session.id);
      this.changed();
    });
    window.on('page-title-updated', (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (url !== this.url(session.id)) event.preventDefault();
    });
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    try {
      await window.loadURL(this.url(session.id));
      if (!window.isDestroyed()) {
        entry.ready = true;
        this.showAll(window);
        remember();
      }
      this.changed();
    } catch (error) {
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
  }

  focus(id: string) {
    const entry = this.entries.get(id);
    if (!entry?.ready || entry.window.isDestroyed()) return;
    this.showAll(entry.window);
  }

  close(id: string) {
    const window = this.entries.get(id)?.window;
    if (!window || window.isDestroyed()) return;
    // Closing the active widget should leave another widget active, rather than
    // activating the editor and hiding all the remaining conversations.
    if (window.isFocused()) {
      const sibling = [...this.entries.values()].find(
        (entry) =>
          entry.window !== window &&
          entry.ready &&
          !entry.window.isDestroyed() &&
          entry.window.isVisible(),
      );
      sibling?.window.focus();
    }
    window.close();
  }

  configure(
    id: string,
    update: {
      opacity?: number;
      alwaysOnTop?: boolean;
      glass?: boolean;
      blur?: boolean;
      glassStrength?: number;
    },
  ) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Esta ventana flotante ya está cerrada.');
    if (update.opacity !== undefined)
      entry.preferences.opacity = Math.max(MIN_FLOATING_OPACITY, Math.min(1, update.opacity));
    if (update.glassStrength !== undefined)
      entry.preferences.glassStrength = Math.max(0, Math.min(2, update.glassStrength));
    if (update.glass !== undefined) {
      entry.preferences.glass = update.glass;
    }
    if (update.blur !== undefined) {
      entry.preferences.blur = update.blur;
      if (process.platform === 'darwin')
        entry.window.setVibrancy(update.blur ? 'under-window' : null);
    }
    if (update.alwaysOnTop !== undefined) {
      entry.preferences.alwaysOnTop = update.alwaysOnTop;
      entry.window.setAlwaysOnTop(update.alwaysOnTop, 'floating');
      if (process.platform === 'darwin')
        entry.window.setVisibleOnAllWorkspaces(update.alwaysOnTop, { visibleOnFullScreen: true });
    }
    this.preferences[id] = { ...entry.preferences, bounds: entry.window.getBounds() };
    this.savePreferences();
    this.changed();
  }
}
