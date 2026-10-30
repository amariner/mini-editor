import {
  BrowserWindow,
  WebContentsView,
  nativeImage,
  safeStorage,
  session as electronSession,
} from 'electron';
import { BrowserSessions, restorableCookies } from './browser-sessions';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { localEndpoint, localURLs, sharedHostProbe, DevServerRegistry } from './browser-hosts';
import { randomUUID } from 'node:crypto';
import { browserDOM } from './browser-dom';
import { pickBrowserElement, cancelBrowserPick } from './browser-picker';
import { BrowserDownloads } from './browser-downloads';
import { BrowserPermissions } from './browser-permissions';
import { BrowserDialogs } from './browser-dialogs';
import { uploadBrowserFiles } from './browser-upload';
import { dragBrowserPointer } from './browser-drag';
import {
  browserInput,
  browserURL,
  browserPartition,
  externalBrowserURL,
  isAuthenticationURL,
  type BrowserState,
} from '../src/browser-protocol';
type Rect = { x: number; y: number; width: number; height: number };
type Entry = {
  view?: WebContentsView;
  state: BrowserState;
  used: number;
  sequence: number;
  openerId?: string;
  pointer?: { x: number; y: number };
  releaseInput?: () => Promise<void>;
  dialogs?: BrowserDialogs;
};
export class DeskBrowser {
  private probeHost = sharedHostProbe();
  private servers = new DevServerRegistry(this.probeHost);
  serverSnapshot() {
    return this.servers.snapshot();
  }
  private pages = new Map<string, Entry>();
  private queues = new Map<string, Promise<unknown>>();
  private visible?: string;
  private monitor?: NodeJS.Timeout;
  private checking = false;
  private closed = false;
  private securedSessions = new Set<Electron.Session>();
  private defaults = new Map<string, string>();
  private observed = new Set<string>();
  private output = new Map<string, string>();
  private removedProjects = new Set<string>();
  private downloads: BrowserDownloads;
  private permissions: BrowserPermissions;
  private sessions: BrowserSessions;
  constructor(
    private host: () => BrowserWindow | undefined,
    private changed: () => void,
    private opened: (id: string, sessionId: string) => void,
    private root?: string,
    private prepareNetwork: (session: Electron.Session) => Promise<void> = async () => {},
    private capabilities: {
      downloadsRoot?: string;
      preload?: string;
      projectRoot?: (projectId: string, sessionId?: string) => Promise<string>;
    } = {},
  ) {
    this.sessions = new BrowserSessions(safeStorage, root, async (session) => {
      // Tabs may already be suspended. A blank, unattached view lets CDP read the
      // exact project's cookie jar including partition metadata, without loading a site.
      const view = new WebContentsView({
        webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      try {
        view.webContents.debugger.attach('1.3');
        // Network is scoped to this target's storage partition. Storage.getCookies
        // without a browserContextId instead reads the default browser context.
        const result = await view.webContents.debugger.sendCommand('Network.getAllCookies');
        return restorableCookies(result.cookies);
      } finally {
        view.webContents.close({ waitForBeforeUnload: false });
      }
    });
    this.downloads = new BrowserDownloads(
      capabilities.downloadsRoot ?? path.join(root ?? os.tmpdir(), 'browser-downloads'),
      changed,
    );
    this.permissions = new BrowserPermissions(
      (wc) => [...this.pages.values()].some((page) => page.view?.webContents === wc),
      changed,
    );
    if (root) {
      try {
        const saved = z
          .array(
            z.object({
              id: z.string().max(150),
              sessionId: z.string().max(150),
              projectId: z.string().optional(),
              url: z.string().max(4096),
              externalUrl: z.string().max(4096).optional(),
              title: z.string().max(500),
              zoom: z.number().min(0.25).max(3),
            }),
          )
          .max(60)
          .parse(JSON.parse(fs.readFileSync(path.join(root, 'browser-tabs.json'), 'utf8')));
        for (const state of saved) {
          if (state.url) browserURL(state.url);
          if (state.externalUrl) browserURL(state.externalUrl);
          this.pages.set(state.id, {
            state: {
              ...state,
              loading: false,
              suspended: true,
              canGoBack: false,
              canGoForward: false,
            },
            used: Date.now(),
            sequence: 0,
          });
        }
      } catch {
        /* Old or missing browser state never prevents application startup. */
      }
    }
    this.updateMonitor();
    void this.checkHosts();
  }
  private updateMonitor() {
    const needed =
      !this.closed &&
      (this.servers.size > 0 || [...this.pages.values()].some((p) => localEndpoint(p.state.url)));
    if (!needed) {
      clearInterval(this.monitor);
      this.monitor = undefined;
    } else if (!this.monitor) {
      this.monitor = setInterval(() => void this.checkHosts(), 15000);
      this.monitor.unref();
    }
  }
  private save() {
    if (!this.root || this.closed) return;
    const saved = this.snapshot()
      .filter((p) => p.url !== 'about:blank' && !p.url.startsWith('blob:'))
      .map(({ id, sessionId, projectId, url, title, zoom, externalUrl }) => ({
        id,
        sessionId,
        projectId,
        url: isAuthenticationURL(url) ? externalBrowserURL(url, externalUrl) : url,
        externalUrl,
        title,
        zoom,
      }));
    const file = path.join(this.root, 'browser-tabs.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(saved), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }
  async checkHosts() {
    if (this.checking || this.closed) return;
    this.checking = true;
    try {
      await Promise.all([
        this.servers.refresh().then((changed) => {
          if (changed) this.changed();
        }),
        ...[...this.pages.values()].map(async (entry) => {
          const url = entry.state.url;
          const online = await this.probeHost(url);
          if (this.closed || entry.state.url !== url || !this.pages.has(entry.state.id)) return;
          const status = online === undefined ? undefined : online ? 'online' : 'offline';
          if (entry.state.hostStatus !== status) {
            entry.state.hostStatus = status;
            this.changed();
          }
        }),
      ]);
    } finally {
      this.checking = false;
      this.updateMonitor();
    }
  }
  async observe(projectId: string, sessionId: string, output: string) {
    if (this.closed || this.removedProjects.has(projectId)) return;
    const text = ((this.output.get(sessionId) ?? '') + output).slice(-6000);
    this.output.delete(sessionId);
    this.output.set(sessionId, text);
    if (this.output.size > 256) this.output.delete(this.output.keys().next().value!);
    if (await this.servers.observe(projectId, sessionId, text)) this.changed();
    this.updateMonitor();
    if (this.closed || this.removedProjects.has(projectId) || !this.output.has(sessionId)) return;
    const online = new Set(
      this.servers
        .snapshot()
        .filter((server) => server.sessionId === sessionId)
        .map((server) => server.port),
    );
    for (const url of localURLs(text)) {
      if (!online.has(localEndpoint(url)!.port)) continue;
      const key = sessionId + ':' + url;
      if (this.observed.has(key)) continue;
      this.observed.add(key);
      if (this.observed.size > 2000) this.observed.delete(this.observed.values().next().value!);
      // Discovery advertises a preview; only opening it or an explicit browser tool call
      // may create a Chromium renderer and request the page.
      const existing = this.snapshot().find(
        (p) =>
          p.projectId === projectId &&
          p.sessionId === sessionId &&
          p.url &&
          new URL(p.url).origin === new URL(url).origin,
      );
      if (!existing && this.pages.size < 60) {
        const tab = this.create(projectId, sessionId, url, false);
        tab.hostStatus = 'online';
        this.defaults.set(sessionId, tab.id);
      }
    }
  }
  create(projectId?: string, sessionId = '', url = '', activate = true) {
    if (projectId && this.removedProjects.has(projectId))
      throw new Error('Este proyecto se ha quitado.');
    if (this.pages.size >= 60)
      throw new Error('Hay 60 pestañas guardadas. Cierra alguna para continuar.');
    if (url) url = browserURL(url);
    const id = sessionId && !this.pages.has(sessionId) ? sessionId : randomUUID();
    this.pages.set(id, {
      used: Date.now(),
      sequence: 0,
      state: {
        id,
        sessionId,
        projectId,
        url,
        externalUrl: url ? externalBrowserURL(url) : undefined,
        zoom: 1,
        title: 'Nueva página',
        suspended: true,
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
    });
    this.save();
    this.updateMonitor();
    void this.checkHosts();
    this.changed();
    if (activate) this.opened(id, sessionId);
    return this.pages.get(id)!.state;
  }
  async forSession(sessionId: string, projectId: string, input: unknown, activate = true) {
    const args = browserInput.parse(input);
    if (args.action === 'list')
      return { tabs: this.snapshot().filter((p) => p.projectId === projectId) };
    let id = args.tabId ?? this.defaults.get(sessionId);
    if (args.tabId && this.pages.get(args.tabId)?.state.projectId !== projectId)
      throw new Error('La pestaña no pertenece a este proyecto.');
    if (!args.tabId && args.action === 'navigate') {
      const origin = new URL(browserURL(args.url)).origin;
      const match = this.snapshot().find(
        (p) =>
          p.projectId === projectId &&
          p.sessionId === sessionId &&
          p.url &&
          new URL(p.url).origin === origin,
      );
      id = match?.id;
    }
    if (args.action === 'new' || !id || !this.pages.has(id)) {
      if (!['navigate', 'new'].includes(args.action)) {
        id = this.snapshot().find(
          (p) => p.projectId === projectId && p.sessionId === sessionId,
        )?.id;
        if (!id) throw new Error('Abre primero una dirección con navigate o consulta list.');
      } else
        id = this.create(
          projectId,
          sessionId,
          args.action === 'navigate' || args.action === 'new' ? args.url : '',
          activate,
        ).id;
    }
    this.defaults.set(sessionId, id!);
    if (args.action === 'new')
      return args.url
        ? this.action(id!, { action: 'navigate', url: args.url }, sessionId)
        : this.pages.get(id!)!.state;
    if (activate && args.action === 'navigate') this.opened(id!, sessionId);
    return this.action(id!, args, sessionId);
  }
  snapshot() {
    return [...this.pages.values()].map((p) => ({
      ...p.state,
      downloads: this.downloads.list(p.state.id),
      dialog: p.dialogs?.current,
      permissions: this.permissions.list(p.view?.webContents),
    }));
  }
  downloadSnapshot() {
    return this.downloads.list();
  }
  private ensure(id: string, inherited?: Electron.WebContentsViewConstructorOptions): Entry {
    const existing = this.pages.get(id);
    if (existing?.view && !existing.view.webContents.isDestroyed()) {
      existing.used = Date.now();
      return existing;
    }
    const live = [...this.pages.values()].filter((p) => p.view).length;
    if (live >= 6)
      throw new Error('Hay seis páginas cargadas. Suspende una pestaña para liberar memoria.');
    const view = new WebContentsView({
      ...(inherited?.webContents ? { webContents: inherited.webContents } : {}),
      webPreferences: {
        ...inherited?.webPreferences,
        partition: browserPartition(existing?.state.projectId),
        session: electronSession.fromPartition(browserPartition(existing?.state.projectId)),
        preload: this.capabilities.preload,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    const wc = view.webContents;
    const entry: Entry = {
      ...(existing ?? {}),
      view,
      used: Date.now(),
      sequence: existing?.sequence ?? 0,
      state: existing?.state ?? {
        id,
        sessionId: id,
        url: '',
        zoom: 1,
        title: 'Nueva página',
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
    };
    entry.state.suspended = false;
    wc.setBackgroundThrottling(true);
    wc.setZoomFactor(entry.state.zoom);
    this.pages.set(id, entry);
    entry.dialogs = new BrowserDialogs(wc, () => this.changed());
    entry.dialogs.attach();
    view.setVisible(false);
    view.setBorderRadius(8);
    const host = this.host();
    if (host && !host.isDestroyed()) host.contentView.addChildView(view, 0);
    view.setBounds({ x: 0, y: 0, width: 1000, height: 720 });
    wc.on('before-input-event', (event, input) => {
      if ((input.meta || input.control) && ['k', ','].includes(input.key.toLowerCase())) {
        event.preventDefault();
        const host = this.host();
        host?.webContents.send('desk:event', {
          type: 'shortcut',
          action: input.key === ',' ? 'settings' : 'search',
        });
        host?.webContents.focus();
      }
    });
    if (!this.securedSessions.has(wc.session)) {
      this.securedSessions.add(wc.session);
      this.permissions.install(wc.session);
      wc.session.on('will-download', (event, item, source) => {
        const owner = [...this.pages.values()].find((page) => page.view?.webContents === source);
        if (!owner) {
          event.preventDefault();
          return;
        }
        this.downloads.handle(event, item, source, owner.state);
      });
      wc.session.webRequest.onBeforeRequest((details, callback) => {
        const top = details.resourceType === 'mainFrame';
        const scheme = new URL(details.url).protocol;
        const source = [...this.pages.values()].find(
          (page) => page.view?.webContents.id === details.webContentsId,
        );
        const localBlob =
          scheme === 'blob:' &&
          !!source?.state.url &&
          new URL(details.url).origin === new URL(source.state.url).origin;
        callback({
          cancel: top
            ? !['http:', 'https:', 'about:'].includes(scheme) && !localBlob
            : ['file:', 'devtools:'].includes(scheme),
        });
      });
    }
    const guard = (event: { preventDefault: () => void }, url: string) => {
      try {
        if (
          url.startsWith('blob:') &&
          entry.state.url &&
          new URL(url).origin === new URL(entry.state.url).origin
        )
          return;
        if (url !== 'about:blank') browserURL(url);
      } catch {
        event.preventDefault();
        entry.state.error = 'Esta dirección no está permitida en la vista previa.';
        this.changed();
      }
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.setWindowOpenHandler(({ url }) => {
      try {
        const safe =
          !url || url === 'about:blank'
            ? 'about:blank'
            : url.startsWith('blob:') &&
                entry.state.url &&
                new URL(url).origin === new URL(entry.state.url).origin
              ? url
              : browserURL(url);
        if (this.pages.size >= 60 || [...this.pages.values()].filter((p) => p.view).length >= 6)
          throw new Error('Cierra o suspende una pestaña antes de abrir otra ventana.');
        return {
          action: 'allow',
          outlivesOpener: true,
          createWindow: (options) => {
            // Let Chromium perform the navigation: preserve POST bodies, window.opener,
            // sessionStorage cloning and postMessage rather than cancel/reload the URL.
            const tab = this.create(entry.state.projectId, entry.state.sessionId);
            const child = this.ensure(tab.id, options);
            child.openerId = id;
            child.state.url = safe;
            child.state.externalUrl =
              safe === 'about:blank' || safe.startsWith('blob:')
                ? entry.state.externalUrl
                : externalBrowserURL(safe, entry.state.externalUrl || entry.state.url);
            this.save();
            this.changed();
            return child.view!.webContents;
          },
        };
      } catch (error) {
        entry.state.error = (error as Error).message;
        this.changed();
        return { action: 'deny' };
      }
    });
    const update = () => {
      if (wc.isDestroyed()) return;
      Object.assign(entry.state, {
        url: wc.getURL() || entry.state.url,
        title: wc.getTitle() || 'Nueva página',
        loading: wc.isLoading(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
      });
      this.changed();
    };
    wc.on('did-start-loading', update);
    wc.on('did-stop-loading', update);
    wc.on('did-navigate', () => {
      update();
      if (entry.state.url !== 'about:blank' && !entry.state.url.startsWith('blob:'))
        entry.state.externalUrl = externalBrowserURL(entry.state.url, entry.state.externalUrl);
      this.save();
      void this.checkHosts();
    });
    wc.on('did-navigate-in-page', () => {
      update();
      if (entry.state.url !== 'about:blank' && !entry.state.url.startsWith('blob:'))
        entry.state.externalUrl = externalBrowserURL(entry.state.url, entry.state.externalUrl);
      this.save();
    });
    wc.on('page-title-updated', () => {
      update();
      this.save();
    });
    wc.on('did-fail-load', (_e, code, description, _url, main) => {
      if (main && code !== -3) {
        entry.state.error = `No se pudo abrir la página: ${description}`;
        update();
      }
    });
    wc.on('destroyed', () => {
      if (this.pages.get(id)?.view === view) {
        entry.view = undefined;
        entry.state.suspended = true;
        if (entry.openerId) {
          if (host && !host.isDestroyed()) host.contentView.removeChildView(view);
          this.pages.delete(id);
          for (const [owner, tab] of this.defaults) if (tab === id) this.defaults.delete(owner);
          if (this.visible === id) {
            this.visible = undefined;
            const opener = this.pages.get(entry.openerId);
            if (opener) this.opened(opener.state.id, opener.state.sessionId);
          }
          this.save();
        }
        this.changed();
      }
    });
    wc.on('render-process-gone', () => {
      entry.state.error = 'La página se ha cerrado inesperadamente. Recárgala.';
      this.changed();
    });
    this.changed();
    return entry;
  }
  present(id: string, bounds: Rect, visible: boolean) {
    if (!visible) {
      this.pages.get(id)?.view?.setVisible(false);
      if (this.visible === id) this.visible = undefined;
      return;
    }
    if (this.visible && this.visible !== id) {
      this.pages.get(this.visible)?.view?.setVisible(false);
      this.visible = undefined;
    }
    const host = this.host();
    if (!host || host.isDestroyed()) return;
    const entry = this.pages.get(id);
    if (!entry?.view) return;
    const size = host.getContentBounds();
    const x = Math.max(0, Math.min(Math.round(bounds.x), size.width));
    const y = Math.max(0, Math.min(Math.round(bounds.y), size.height));
    const width = Math.max(0, Math.min(Math.round(bounds.width), size.width - x));
    const height = Math.max(0, Math.min(Math.round(bounds.height), size.height - y));
    if (host.contentView.children.at(-1) !== entry.view) host.contentView.addChildView(entry.view);
    if (width < 1 || height < 1) {
      entry.view.setVisible(false);
      this.visible = undefined;
      return;
    }
    entry.view.setBounds({ x, y, width, height });
    entry.view.setVisible(width > 0 && height > 0);
    this.visible = id;
  }
  hide() {
    for (const p of this.pages.values()) p.view?.setVisible(false);
    this.visible = undefined;
  }
  suspend(id: string) {
    const p = this.pages.get(id);
    if (!p) return;
    if (p.view) {
      const host = this.host();
      if (host && !host.isDestroyed()) host.contentView.removeChildView(p.view);
      const wc = p.view.webContents;
      p.view = undefined;
      wc.close({ waitForBeforeUnload: false });
    }
    p.state.suspended = true;
    p.state.loading = false;
    p.state.canGoBack = false;
    p.state.canGoForward = false;
    if (this.visible === id) this.visible = undefined;
    this.changed();
  }
  close(id: string) {
    this.suspend(id);
    this.pages.delete(id);
    for (const [owner, tab] of this.defaults) if (tab === id) this.defaults.delete(owner);
    this.save();
    this.updateMonitor();
    this.changed();
  }
  async removeSessions(sessionIds: string[]) {
    const ids = new Set(sessionIds);
    this.servers.removeSessions(ids);
    const tabs = this.snapshot().filter((tab) => ids.has(tab.sessionId));
    for (const tab of tabs) this.close(tab.id);
    for (const id of ids) {
      this.output.delete(id);
      this.defaults.delete(id);
      for (const key of this.observed) if (key.startsWith(id + ':')) this.observed.delete(key);
    }
    this.updateMonitor();
    await Promise.allSettled(tabs.map((tab) => this.queues.get(tab.id)));
  }
  async removeProject(projectId: string, sessionIds: string[]) {
    this.removedProjects.add(projectId);
    this.servers.removeProject(projectId);
    const tabs = this.snapshot().filter(
      (tab) => tab.projectId === projectId || sessionIds.includes(tab.sessionId),
    );
    // Close first to interrupt pending navigations; never recreate tabs from queued actions.
    for (const tab of tabs) this.close(tab.id);
    await Promise.allSettled(tabs.map((tab) => this.queues.get(tab.id)));
    for (const id of [...sessionIds, `shell:${projectId}`]) {
      this.output.delete(id);
      this.defaults.delete(id);
    }
    for (const key of this.observed)
      if (
        sessionIds.some((id) => key.startsWith(id + ':')) ||
        key.startsWith(`shell:${projectId}:`)
      )
        this.observed.delete(key);
    this.updateMonitor();
    const ses = electronSession.fromPartition(browserPartition(projectId));
    await this.sessions.forget(ses);
    await ses.closeAllConnections();
    await ses.clearCache();
    await ses.clearStorageData();
    await ses.clearAuthCache();
    this.save();
  }
  async closeAll() {
    this.save();
    this.closed = true;
    this.downloads.close();
    this.permissions.close();
    clearInterval(this.monitor);
    for (const id of this.pages.keys()) this.suspend(id);
    this.pages.clear();
    this.servers.clear();
    this.output.clear();
    this.observed.clear();
    await Promise.allSettled(
      [...this.securedSessions].map(async (session) => {
        try {
          await this.sessions.save(session);
        } finally {
          session.flushStorageData();
          await session.cookies.flushStore();
        }
      }),
    );
  }
  externalURL(id: string) {
    const state = this.pages.get(id)?.state;
    if (!state?.url) throw new Error('Abre primero una página.');
    return (state.url === 'about:blank' || state.url.startsWith('blob:')) && state.externalUrl
      ? browserURL(state.externalUrl)
      : externalBrowserURL(state.url, state.externalUrl);
  }
  private async loadPage(wc: Electron.WebContents, url: string) {
    // Third-party analytics and long-lived resources must not block the tool queue forever.
    // DOM readiness is enough for inspect; subsequent actions still validate fresh targets.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        wc.removeListener('dom-ready', ready);
        wc.removeListener('destroyed', destroyed);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const ready = () => finish();
      const destroyed = () => finish(new Error('La pestaña se ha cerrado durante la navegación.'));
      const expired = () => {
        const pendingDialog = [...this.pages.values()].find((page) => page.view?.webContents === wc)
          ?.dialogs?.current;
        if (pendingDialog) {
          timer = setTimeout(expired, 20000);
          return;
        }
        finish(
          new Error(
            'La página no respondió en 20 segundos. Comprueba la dirección o vuelve a cargarla.',
          ),
        );
        if (!wc.isDestroyed()) wc.stop();
      };
      let timer = setTimeout(expired, 20000);
      wc.once('dom-ready', ready);
      wc.once('destroyed', destroyed);
      void wc.loadURL(url).then(ready, (error) => finish(error));
    });
  }
  async pick(id: string) {
    if (!this.pages.has(id)) throw new Error('La pestaña ya no existe.');
    const dormant = this.pages.get(id)!.state.suspended;
    const p = this.ensure(id);
    const wc = p.view!.webContents;
    await this.sessions.restore(wc.session);
    await this.prepareNetwork(wc.session);
    if (dormant && p.state.url) await this.loadPage(wc, p.state.url);
    return pickBrowserElement(wc);
  }
  async cancelPick(id: string) {
    const wc = this.pages.get(id)?.view?.webContents;
    if (wc && !wc.isDestroyed()) await cancelBrowserPick(wc);
  }
  async revealDownload(tabId: string, downloadId: string) {
    return this.downloads.revealPath(downloadId, tabId);
  }
  controlDownload(tabId: string, downloadId: string, operation: 'pause' | 'resume' | 'cancel') {
    this.downloads[operation](downloadId, tabId);
  }
  respondPermission(tabId: string, permissionId: string, allow: boolean) {
    const wc = this.pages.get(tabId)?.view?.webContents;
    if (!wc || wc.isDestroyed()) throw new Error('La pestaña ya no está cargada.');
    this.permissions.respond(wc, permissionId, allow);
  }
  action(id: string, input: unknown, sessionId?: string): Promise<any> {
    const args = browserInput.parse(input);
    // Answer a modal outside the action queue: the action opening it may still be returning.
    if (args.action === 'dialog') {
      const dialogs = this.pages.get(id)?.dialogs;
      if (!dialogs)
        return Promise.reject(new Error('No hay un diálogo pendiente en esta pestaña.'));
      return dialogs.respond(args.dialogId, args.accept, args.promptText);
    }
    const current = this.pages.get(id);
    if (current?.dialogs?.current && !['close', 'suspend'].includes(args.action)) {
      if (args.action === 'list') return Promise.resolve({ tabs: this.snapshot() });
      if (args.action === 'downloads')
        return Promise.resolve({ ok: true, downloads: this.downloads.list(id) });
      return Promise.resolve({
        ok: args.action === 'inspect',
        url: current.state.url,
        title: current.state.title,
        text: 'Diálogo pendiente de respuesta.',
        elements: [],
        dialog: current.dialogs.current,
      });
    }
    if (current?.dialogs?.current && ['close', 'suspend'].includes(args.action)) {
      if (args.action === 'close') this.close(id);
      else this.suspend(id);
      return Promise.resolve({ ok: true });
    }
    let expose!: (result: unknown) => void;
    let exposeError!: (error: unknown) => void;
    const response = new Promise((resolve, reject) => {
      expose = resolve;
      exposeError = reject;
    });
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const page = this.pages.get(id);
        const tracked = !['list', 'close', 'suspend', 'zoom'].includes(args.action);
        if (tracked && page) {
          page.state.activity = {
            action: args.action,
            phase: 'running',
            at: Date.now(),
            sessionId,
          };
          this.changed();
        }
        try {
          const operation = this.perform(id, args, sessionId);
          const dialogs = this.pages.get(id)?.dialogs;
          void (dialogs ? dialogs.race(operation) : operation).then(expose, exposeError);
          // Keep the actual operation in the queue even when the caller receives a dialog.
          // Its remaining mouse/key events finish before a subsequent action is dispatched.
          const result = await operation;
          if (tracked && page?.state.activity) {
            page.state.activity = { ...page.state.activity, phase: 'done', at: Date.now() };
            this.changed();
          }
          return result;
        } catch (error) {
          if (tracked && page?.state.activity) {
            page.state.activity = {
              ...page.state.activity,
              phase: 'error',
              at: Date.now(),
              error: (error as Error).message,
            };
            this.changed();
          }
          throw error;
        } finally {
          const activePage = this.pages.get(id) ?? page;
          await activePage?.releaseInput?.();
          if (activePage) activePage.releaseInput = undefined;
        }
      });
    this.queues.set(id, next);
    void next
      .finally(() => {
        if (this.queues.get(id) === next) this.queues.delete(id);
      })
      .catch(exposeError);
    return response;
  }
  private async perform(
    id: string,
    args: ReturnType<typeof browserInput.parse>,
    sessionId?: string,
  ) {
    if (!this.pages.has(id)) throw new Error('La pestaña ya no existe.');
    if (args.action === 'list') return { tabs: this.snapshot() };
    if (args.action === 'downloads') return { ok: true, downloads: this.downloads.list(id) };
    if (args.action === 'downloadControl') {
      this.downloads[args.operation](args.downloadId, id);
      return { ok: true, downloads: this.downloads.list(id) };
    }
    if (args.action === 'new') {
      const owner = this.pages.get(id)?.state;
      const tab = this.create(owner?.projectId, owner?.sessionId, args.url);
      return args.url ? this.action(tab.id, { action: 'navigate', url: args.url }) : tab;
    }
    if (args.action === 'suspend') {
      this.suspend(id);
      return { ok: true };
    }
    if (args.action === 'close') {
      this.close(id);
      return { ok: true };
    }
    if (!this.pages.has(id) && args.action !== 'navigate')
      throw new Error('Abre primero una dirección con navigate.');
    const dormant = this.pages.get(id)?.state.suspended;
    const p = this.ensure(id);
    const wc = p.view!.webContents;
    await this.sessions.restore(wc.session);
    await this.prepareNetwork(wc.session);
    if (dormant && args.action !== 'navigate' && p.state.url) await this.loadPage(wc, p.state.url);
    if (p.dialogs?.current)
      return {
        ok: args.action === 'inspect',
        url: p.state.url,
        title: p.state.title,
        text: 'La página tiene un diálogo pendiente.',
        elements: [],
        dialog: p.dialogs.current,
        error: args.action === 'inspect' ? undefined : 'Responde al diálogo antes de continuar.',
      };
    if (args.action === 'download') {
      const url = new URL(args.url);
      if (url.protocol === 'blob:') {
        if (url.origin !== new URL(wc.getURL()).origin)
          throw new Error('El archivo Blob debe pertenecer a esta página.');
      } else browserURL(args.url);
      wc.downloadURL(url.href);
      return {
        ok: true,
        message: 'Descarga solicitada. Consulta downloads para comprobar el resultado.',
        downloads: this.downloads.list(id),
      };
    }
    if (args.action === 'upload') {
      if (!p.state.projectId || !this.capabilities.projectRoot)
        throw new Error(
          'Para subir archivos con el agente, abre esta página dentro de un proyecto. También puedes usar el selector de archivos de la web.',
        );
      const projectRoot = await this.capabilities.projectRoot(
        p.state.projectId,
        sessionId || p.state.sessionId || undefined,
      );
      return uploadBrowserFiles(wc, args.ref, args.paths, projectRoot);
    }
    if (args.action === 'zoom') {
      wc.setZoomFactor(args.factor);
      p.state.zoom = args.factor;
      this.save();
      this.changed();
      return { ok: true, ...p.state };
    }
    const evaluate = (code: string) => wc.executeJavaScriptInIsolatedWorld(1001, [{ code }], true);
    if (args.action !== 'navigate' && wc.getURL()) {
      const viewport = await evaluate('({width:innerWidth,height:innerHeight})');
      if (!viewport.width || !viewport.height) {
        const attached = wc.debugger.isAttached();
        if (!attached) wc.debugger.attach('1.3');
        p.releaseInput = async () => {
          if (!wc.isDestroyed() && wc.debugger.isAttached()) {
            await wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => {});
            if (!attached) wc.debugger.detach();
          }
        };
        const bounds = p.view!.getBounds();
        await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
          width: Math.max(320, Math.round((bounds.width || 1000) / p.state.zoom)),
          height: Math.max(240, Math.round((bounds.height || 720) / p.state.zoom)),
          deviceScaleFactor: 1,
          mobile: false,
        });
      }
    }
    const dom = async (input: Parameters<typeof browserDOM>[0]) => {
      // Electron otherwise replaces isolated-world exceptions with an opaque 'Script failed'
      // message, preventing agents from recovering from stale or obstructed targets.
      const result = await evaluate(
        `(()=>{try{return {success:true,value:(${browserDOM.toString()})(${JSON.stringify(input)})};}catch(error){return {success:false,error:String(error?.message||error)};}})()`,
      );
      if (!result.success) throw new Error(result.error);
      return result.value;
    };
    // The public Electron sendInputEvent API requires the host window to be focused.
    // CDP dispatches trusted input to this tab even when a different chat is foreground.
    // No remote debugging port, page-supplied commands or arbitrary JavaScript are exposed.
    const nativeInput = async (
      run: (send: (method: string, params: object) => Promise<any>) => Promise<void>,
    ) => {
      const attached = wc.debugger.isAttached();
      try {
        if (!attached) wc.debugger.attach('1.3');
        await run((method, params) => wc.debugger.sendCommand(method, params));
      } finally {
        if (!attached && !wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach();
      }
    };
    if (args.action === 'navigate') {
      p.state.error = undefined;
      p.state.url = browserURL(args.url);
      p.state.externalUrl = externalBrowserURL(p.state.url);
      this.save();
      this.updateMonitor();
      void this.checkHosts();
      await this.loadPage(wc, p.state.url);
      wc.setZoomFactor(p.state.zoom);
      void this.checkHosts();
    } else if (args.action === 'back' && wc.navigationHistory.canGoBack())
      wc.navigationHistory.goBack();
    else if (args.action === 'forward' && wc.navigationHistory.canGoForward())
      wc.navigationHistory.goForward();
    else if (args.action === 'reload') {
      p.state.error = undefined;
      if (!dormant) wc.reload();
    } else if (args.action === 'screenshot') {
      let capture = await wc.capturePage();
      // A page created in a background conversation has no compositor frame yet.
      // Ask Chromium for this page only; never expose a general CDP endpoint.
      if (capture.isEmpty()) {
        const attached = wc.debugger.isAttached();
        try {
          if (!attached) wc.debugger.attach('1.3');
          const { width, height } = await dom({ action: 'viewport' });
          await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
            width,
            height,
            deviceScaleFactor: 1,
            mobile: false,
          });
          const result = await wc.debugger.sendCommand('Page.captureScreenshot', {
            format: 'png',
            fromSurface: true,
            clip: { x: 0, y: 0, width, height, scale: 1 },
          });
          capture = nativeImage.createFromBuffer(Buffer.from(result.data, 'base64'));
        } finally {
          if (!wc.isDestroyed() && wc.debugger.isAttached()) {
            if (!p.releaseInput)
              await wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => {});
            if (!attached) wc.debugger.detach();
          }
        }
      }
      if (capture.isEmpty())
        throw new Error(
          'La página aún no ha generado una imagen. Abre su panel de navegador y vuelve a intentarlo.',
        );
      const viewport = await dom({ action: 'viewport' });
      const imageWidth = Math.min(p.view!.getBounds().width, 1440);
      const imageSize = capture.resize({ width: imageWidth }).getSize();
      return {
        ok: true,
        viewport,
        imageSize,
        image: capture
          .resize({ width: Math.min(p.view!.getBounds().width, 1440) })
          .toPNG()
          .toString('base64'),
        mimeType: 'image/png',
      };
    } else if (args.action === 'inspect')
      return { ok: true, ...(await dom({ action: 'inspect', sequence: ++p.sequence })) };
    else if (args.action === 'drag') {
      await dom({ action: 'point', ref: args.ref, x: args.x, y: args.y });
      await dom({ action: 'point', ref: args.toRef, x: args.toX, y: args.toY });
      // Validate both endpoints in one viewport; never drop at stale coordinates after a scroll.
      const source = await dom({
        action: 'point',
        ref: args.ref,
        x: args.x,
        y: args.y,
        scrollIntoView: false,
      });
      const to = await dom({
        action: 'point',
        ref: args.toRef,
        x: args.toX,
        y: args.toY,
        scrollIntoView: false,
      });
      await dragBrowserPointer(wc, source, to);
    } else if (args.action === 'check') {
      const target = await dom(args);
      if (target.needsClick) {
        await nativeInput(async (send) => {
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y });
          await send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: target.x,
            y: target.y,
            button: 'left',
            clickCount: 1,
          });
          await send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: target.x,
            y: target.y,
            button: 'left',
            clickCount: 1,
          });
        });
        const result = await dom(args);
        if (result.needsClick)
          throw new Error('La casilla no cambió al estado solicitado. Inspecciona el formulario.');
      }
      return { ok: true, checked: args.checked };
    } else if (['click', 'hover', 'move'].includes(args.action)) {
      if (args.action !== 'click' && args.action !== 'hover' && args.action !== 'move') return;
      const target = await dom({
        action: 'point',
        ...('ref' in args ? { ref: args.ref } : {}),
        x: args.x,
        y: args.y,
      });
      if (p.state.activity) p.state.activity.label = target.label;
      this.changed();
      await nativeInput(async (send) => {
        const start = p.pointer ?? { x: target.x, y: target.y };
        for (let step = 1; step <= 6; step++) {
          await send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: start.x + ((target.x - start.x) * step) / 6,
            y: start.y + ((target.y - start.y) * step) / 6,
          });
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        p.pointer = { x: target.x, y: target.y };
        if (args.action === 'click') {
          const button = args.button ?? 'left';
          for (let click = 1; click <= (args.clickCount ?? 1); click++) {
            await send('Input.dispatchMouseEvent', {
              type: 'mousePressed',
              x: target.x,
              y: target.y,
              button,
              clickCount: click,
            });
            await send('Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              x: target.x,
              y: target.y,
              button,
              clickCount: click,
            });
          }
        }
      });
    } else if (args.action === 'fill' || args.action === 'select') {
      const result = await dom(args);
      if (p.state.activity) p.state.activity.label = result.label;
      if (result.insertText !== undefined)
        await nativeInput((send) => send('Input.insertText', { text: result.insertText }));
    } else if (args.action === 'press') {
      const keyCodes: Record<string, number> = {
        Enter: 13,
        Tab: 9,
        Escape: 27,
        ArrowDown: 40,
        ArrowUp: 38,
        ArrowLeft: 37,
        ArrowRight: 39,
        Backspace: 8,
        Delete: 46,
        Home: 36,
        End: 35,
        PageUp: 33,
        PageDown: 34,
        Space: 32,
      };
      const key = args.key === 'Space' ? ' ' : args.key;
      const modifiers = (args.modifiers ?? []).reduce(
        (bits, modifier) => bits | { alt: 1, control: 2, meta: 4, shift: 8 }[modifier],
        0,
      );
      const text =
        modifiers & 7
          ? undefined
          : args.key === 'Enter'
            ? '\r'
            : key.length === 1
              ? key
              : undefined;
      const event = {
        key,
        code: key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : args.key,
        windowsVirtualKeyCode: keyCodes[args.key] ?? key.toUpperCase().charCodeAt(0),
        modifiers,
      };
      const editing = (args.modifiers ?? []).includes(
        process.platform === 'darwin' ? 'meta' : 'control',
      );
      const command = editing
        ? (
            {
              a: 'selectAll',
              c: 'copy',
              v: 'paste',
              x: 'cut',
              z: modifiers & 8 ? 'redo' : 'undo',
            } as Record<string, string>
          )[args.key]
        : undefined;
      await nativeInput(async (send) => {
        await send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          ...event,
          text,
          unmodifiedText: text,
          ...(command ? { commands: [command] } : {}),
        });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
      });
    } else if (args.action === 'scroll') return { ok: true, ...p.state, ...(await dom(args)) };
    return { ok: true, ...p.state };
  }
}
