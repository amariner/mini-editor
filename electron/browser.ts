import { BrowserWindow, WebContentsView, nativeImage } from 'electron';
import { randomUUID } from 'node:crypto';
import { browserInput, browserURL, type BrowserState } from '../src/browser-protocol';
type Rect = { x: number; y: number; width: number; height: number };
type Entry = { view: WebContentsView; state: BrowserState; used: number };
export class DeskBrowser {
  private pages = new Map<string, Entry>();
  private queues = new Map<string, Promise<unknown>>();
  private visible?: string;
  constructor(
    private host: () => BrowserWindow | undefined,
    private changed: () => void,
    private opened: (id: string) => void,
  ) {}
  snapshot() {
    return [...this.pages.values()].map((p) => p.state);
  }
  private ensure(id: string): Entry {
    const existing = this.pages.get(id);
    if (existing) {
      existing.used = Date.now();
      return existing;
    }
    if (this.pages.size >= 5) {
      const candidate = [...this.pages.entries()]
        .filter(([key]) => key !== this.visible && !this.queues.has(key))
        .sort((a, b) => a[1].used - b[1].used)[0];
      if (!candidate) throw new Error('Hay cinco navegadores ocupados. Cierra uno para continuar.');
      this.close(candidate[0]);
    }
    const view = new WebContentsView({
      webPreferences: {
        partition: `desk-preview-${randomUUID()}`,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    const wc = view.webContents;
    const entry: Entry = {
      view,
      used: Date.now(),
      state: {
        sessionId: id,
        url: '',
        title: 'Nueva página',
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
    };
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
        void this.action(id, { action: 'navigate', url: safe }).catch(() => {});
      } catch {}
      return { action: 'deny' };
    });
    const update = () => {
      if (wc.isDestroyed()) return;
      Object.assign(entry.state, {
        url: wc.getURL() === 'about:blank' ? '' : wc.getURL(),
        title: wc.getTitle() || 'Nueva página',
        loading: wc.isLoading(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
      });
      this.changed();
    };
    wc.on('did-start-loading', update);
    wc.on('did-stop-loading', update);
    wc.on('did-navigate', update);
    wc.on('did-navigate-in-page', update);
    wc.on('page-title-updated', update);
    wc.on('did-fail-load', (_e, code, description, _url, main) => {
      if (main && code !== -3) {
        entry.state.error = `No se pudo abrir la página: ${description}`;
        update();
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
    if (this.visible && this.visible !== id) {
      this.pages.get(this.visible)?.view.setVisible(false);
      this.visible = undefined;
    }
    if (!visible) {
      this.pages.get(id)?.view.setVisible(false);
      if (this.visible === id) this.visible = undefined;
      return;
    }
    const host = this.host();
    if (!host || host.isDestroyed()) return;
    const entry = this.ensure(id);
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
    for (const p of this.pages.values()) p.view.setVisible(false);
    this.visible = undefined;
  }
  close(id: string) {
    const p = this.pages.get(id);
    if (!p) return;
    const host = this.host();
    if (host && !host.isDestroyed()) host.contentView.removeChildView(p.view);
    p.view.webContents.close({ waitForBeforeUnload: false });
    this.pages.delete(id);
    if (this.visible === id) this.visible = undefined;
    this.changed();
  }
  closeAll() {
    for (const id of [...this.pages.keys()]) this.close(id);
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
    if (args.action === 'close') {
      this.close(id);
      return { ok: true };
    }
    if (!this.pages.has(id) && args.action !== 'navigate')
      throw new Error('Abre primero una dirección con navigate.');
    const p = this.ensure(id);
    const wc = p.view.webContents;
    this.opened(id);
    const evaluate = (code: string) => wc.executeJavaScriptInIsolatedWorld(1001, [{ code }], true);
    if (args.action === 'navigate') {
      p.state.error = undefined;
      await wc.loadURL(browserURL(args.url));
    } else if (args.action === 'back' && wc.navigationHistory.canGoBack())
      wc.navigationHistory.goBack();
    else if (args.action === 'forward' && wc.navigationHistory.canGoForward())
      wc.navigationHistory.goForward();
    else if (args.action === 'reload') {
      p.state.error = undefined;
      wc.reload();
    } else if (args.action === 'screenshot') {
      let capture = await wc.capturePage();
      // A page created in a background conversation has no compositor frame yet.
      // Ask Chromium for this page only; never expose a general CDP endpoint.
      if (capture.isEmpty()) {
        const attached = wc.debugger.isAttached();
        try {
          if (!attached) wc.debugger.attach('1.3');
          const { width, height } = p.view.getBounds();
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
          .resize({ width: Math.min(p.view.getBounds().width, 1440) })
          .toPNG()
          .toString('base64'),
        mimeType: 'image/png',
      };
    } else if (args.action === 'inspect')
      return {
        ok: true,
        ...(await evaluate(`(()=>{
      window.__deskElements=new Map();let n=0;
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
