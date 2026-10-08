import { BrowserWindow, WebContentsView, nativeImage, session as electronSession } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { hostOnline, localURLs } from './browser-hosts';
import { randomUUID } from 'node:crypto';
import { browserInput, browserURL, type BrowserState } from '../src/browser-protocol';
type Rect = { x: number; y: number; width: number; height: number };
type Entry = { view?: WebContentsView; state: BrowserState; used: number; sequence: number };
export class DeskBrowser {
  private pages = new Map<string, Entry>();
  private queues = new Map<string, Promise<unknown>>();
  private visible?: string;
  private monitor?: NodeJS.Timeout;
  private checking = false;
  private closed = false;
  private securedSessions = new WeakSet<object>();
  private defaults = new Map<string, string>();
  private observed = new Set<string>();
  private output = new Map<string, string>();
  private removedProjects = new Set<string>();
  constructor(
    private host: () => BrowserWindow | undefined,
    private changed: () => void,
    private opened: (id: string, sessionId: string) => void,
    private root?: string,
    private prepareNetwork: (session: Electron.Session) => Promise<void> = async () => {},
  ) {
    if (root) {
      try {
        const saved = z
          .array(
            z.object({
              id: z.string().max(150),
              sessionId: z.string().max(150),
              projectId: z.string().optional(),
              url: z.string().max(4096),
              title: z.string().max(500),
              zoom: z.number().min(0.25).max(3),
            }),
          )
          .max(60)
          .parse(JSON.parse(fs.readFileSync(path.join(root, 'browser-tabs.json'), 'utf8')));
        for (const state of saved) {
          if (state.url) browserURL(state.url);
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
    this.monitor = setInterval(() => {
      void this.checkHosts();
    }, 15000);
    this.monitor.unref();
    void this.checkHosts();
  }
  private save() {
    if (!this.root || this.closed) return;
    const saved = this.snapshot().map(({ id, sessionId, projectId, url, title, zoom }) => ({
      id,
      sessionId,
      projectId,
      url,
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
      await Promise.all(
        [...this.pages.values()].map(async (entry) => {
          const url = entry.state.url;
          const online = await hostOnline(url);
          if (this.closed || entry.state.url !== url || !this.pages.has(entry.state.id)) return;
          const status = online === undefined ? undefined : online ? 'online' : 'offline';
          if (entry.state.hostStatus !== status) {
            entry.state.hostStatus = status;
            this.changed();
          }
        }),
      );
    } finally {
      this.checking = false;
    }
  }
  async observe(projectId: string, sessionId: string, output: string) {
    if (this.closed || this.removedProjects.has(projectId)) return;
    const text = ((this.output.get(sessionId) ?? '') + output).slice(-6000);
    this.output.set(sessionId, text);
    for (const url of localURLs(text)) {
      const key = projectId + ':' + url;
      if (this.observed.has(key)) continue;
      this.observed.add(key);
      if (this.observed.size > 2000) this.observed.delete(this.observed.values().next().value!);
      if (await hostOnline(url)) {
        if (!this.closed && !this.removedProjects.has(projectId))
          await this.forSession(sessionId, projectId, { action: 'navigate', url }).catch(() => {});
      } else this.observed.delete(key);
    }
  }
  create(projectId?: string, sessionId = '', url = '') {
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
        zoom: 1,
        title: 'Nueva página',
        suspended: true,
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
    });
    this.save();
    this.changed();
    this.opened(id, sessionId);
    return this.pages.get(id)!.state;
  }
  async forSession(sessionId: string, projectId: string, input: unknown) {
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
        ).id;
    }
    this.defaults.set(sessionId, id!);
    if (args.action === 'new')
      return args.url
        ? this.action(id!, { action: 'navigate', url: args.url })
        : this.pages.get(id!)!.state;
    if (args.action === 'navigate') this.opened(id!, sessionId);
    return this.action(id!, args);
  }
  snapshot() {
    return [...this.pages.values()].map((p) => p.state);
  }
  private ensure(id: string): Entry {
    const existing = this.pages.get(id);
    if (existing?.view && !existing.view.webContents.isDestroyed()) {
      existing.used = Date.now();
      return existing;
    }
    const live = [...this.pages.values()].filter((p) => p.view).length;
    if (live >= 6)
      throw new Error('Hay seis páginas cargadas. Suspende una pestaña para liberar memoria.');
    const view = new WebContentsView({
      webPreferences: {
        partition: `desk-browser-${existing?.state.projectId ?? 'personal'}`,
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
    view.setVisible(false);
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
      wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      wc.session.setPermissionCheckHandler(() => false);
      wc.session.on('will-download', (event) => event.preventDefault());
      wc.session.webRequest.onBeforeRequest((details, callback) => {
        const top = details.resourceType === 'mainFrame';
        const scheme = new URL(details.url).protocol;
        callback({
          cancel: top
            ? !['http:', 'https:', 'about:'].includes(scheme)
            : ['file:', 'devtools:'].includes(scheme),
        });
      });
    }
    const guard = (event: { preventDefault: () => void }, url: string) => {
      try {
        browserURL(url);
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
        const safe = browserURL(url);
        const tab = this.create(entry.state.projectId, entry.state.sessionId, safe);
        void this.action(tab.id, { action: 'navigate', url: safe }).catch(() => {});
      } catch {}
      return { action: 'deny' };
    });
    const update = () => {
      if (wc.isDestroyed()) return;
      Object.assign(entry.state, {
        url: wc.getURL() && wc.getURL() !== 'about:blank' ? wc.getURL() : entry.state.url,
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
      this.save();
      void this.checkHosts();
    });
    wc.on('did-navigate-in-page', update);
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
    host.contentView.addChildView(entry.view);
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
      p.view.webContents.close({ waitForBeforeUnload: false });
      p.view = undefined;
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
    this.changed();
  }
  async removeProject(projectId: string, sessionIds: string[]) {
    this.removedProjects.add(projectId);
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
    for (const key of this.observed) if (key.startsWith(projectId + ':')) this.observed.delete(key);
    const ses = electronSession.fromPartition(`desk-browser-${projectId}`);
    await ses.closeAllConnections();
    await ses.clearCache();
    await ses.clearStorageData();
    await ses.clearAuthCache();
    this.save();
  }
  closeAll() {
    this.save();
    this.closed = true;
    clearInterval(this.monitor);
    for (const id of this.pages.keys()) this.suspend(id);
    this.pages.clear();
    this.output.clear();
    this.observed.clear();
  }
  action(id: string, input: unknown): Promise<any> {
    const args = browserInput.parse(input);
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.perform(id, args));
    this.queues.set(id, next);
    void next
      .finally(() => {
        if (this.queues.get(id) === next) this.queues.delete(id);
      })
      .catch(() => {});
    return next;
  }
  private async perform(id: string, args: ReturnType<typeof browserInput.parse>) {
    if (!this.pages.has(id)) throw new Error('La pestaña ya no existe.');
    if (args.action === 'list') return { tabs: this.snapshot() };
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
    await this.prepareNetwork(wc.session);
    if (dormant && args.action !== 'navigate' && p.state.url) await wc.loadURL(p.state.url);
    if (args.action === 'zoom') {
      wc.setZoomFactor(args.factor);
      p.state.zoom = args.factor;
      this.save();
      this.changed();
      return { ok: true, ...p.state };
    }
    const evaluate = (code: string) => wc.executeJavaScriptInIsolatedWorld(1001, [{ code }], true);
    if (args.action === 'navigate') {
      p.state.error = undefined;
      p.state.url = browserURL(args.url);
      this.save();
      await wc.loadURL(p.state.url);
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
          const { width, height } = p.view!.getBounds();
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
            await wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => {});
            if (!attached) wc.debugger.detach();
          }
        }
      }
      if (capture.isEmpty())
        throw new Error(
          'La página aún no ha generado una imagen. Abre su panel de navegador y vuelve a intentarlo.',
        );
      return {
        ok: true,
        image: capture
          .resize({ width: Math.min(p.view!.getBounds().width, 1440) })
          .toPNG()
          .toString('base64'),
        mimeType: 'image/png',
      };
    } else if (args.action === 'inspect')
      return {
        ok: true,
        ...(await evaluate(`(()=>{
      window.__deskElements=new Map();let n=${++p.sequence * 1000};
      const elements=[...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')].filter(e=>e.getClientRects().length).slice(0,150).map(e=>{const ref='e'+(++n);window.__deskElements.set(ref,e);return {ref,tag:e.tagName.toLowerCase(),label:(e.getAttribute('aria-label')||e.innerText||e.getAttribute('placeholder')||e.getAttribute('name')||'').slice(0,180),type:e.getAttribute('type'),disabled:!!e.disabled};});
      return {url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,18000),elements};})()`)),
      };
    else if (args.action === 'click' || args.action === 'fill') {
      await evaluate(
        `(()=>{const e=window.__deskElements?.get(${JSON.stringify(args.ref)});if(!e||!e.isConnected)throw new Error('Referencia caducada. Vuelve a inspeccionar.');e.scrollIntoView({block:'center'});e.focus();${args.action === 'click' ? 'e.click();' : `if(e instanceof HTMLInputElement&&['file','password'].includes(e.type))throw new Error('Este campo requiere intervención del usuario.');const value=${JSON.stringify(args.text)};const proto=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:e instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;if(e.isContentEditable)e.textContent=value;else {const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(!setter)throw new Error('El elemento no es editable.');setter.call(e,value);}e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));`}return true;})()`,
      );
    } else if (args.action === 'press') {
      wc.sendInputEvent({ type: 'keyDown', keyCode: args.key });
      wc.sendInputEvent({ type: 'keyUp', keyCode: args.key });
    } else if (args.action === 'scroll') await evaluate(`window.scrollBy(0,${args.deltaY})`);
    return { ok: true, ...p.state };
  }
}
