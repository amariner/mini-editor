import fs from 'node:fs/promises';
import { constants, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type CDPSession,
  type Dialog,
} from 'playwright-core';
import { browserDOM } from './browser-dom';
import { browserUploadPaths } from './browser-upload';
import { downloadFilename } from './browser-downloads';
import {
  browserInput,
  browserURL,
  type BrowserInput,
  type BrowserState,
} from '../src/browser-protocol';
import type { ChromeConnection, ChromeMode } from '../src/chrome-types';
import type { BrowserDownload } from '../src/browser-downloads';

export function chromeProfileDirectory(home = os.homedir(), platform = process.platform) {
  if (platform === 'darwin') return path.join(home, 'Library/Application Support/Google/Chrome');
  if (platform === 'win32')
    return path.join(
      process.env.LOCALAPPDATA || path.join(home, 'AppData/Local'),
      'Google/Chrome/User Data',
    );
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'google-chrome');
}

/** Same discovery as Chrome DevTools MCP autoConnect. Chrome owns the consent prompt. */
export function chromeEndpoint(text: string) {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (
    lines.length !== 2 ||
    !/^\d{1,5}$/.test(lines[0]) ||
    Number(lines[0]) < 1 ||
    Number(lines[0]) > 65535 ||
    !/^\/devtools\/browser\/[a-z0-9_-]{1,200}$/i.test(lines[1])
  )
    throw new Error(
      'Chrome publicó una conexión inválida. Desactiva y vuelve a activar la depuración remota en Chrome.',
    );
  return `ws://127.0.0.1:${Number(lines[0])}${lines[1]}`;
}

export async function installedChrome(executable?: string) {
  const candidates = executable
    ? [executable]
    : process.platform === 'darwin'
      ? [
          path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        ]
      : process.platform === 'win32'
        ? [
            path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
            path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
            path.join(
              process.env['PROGRAMFILES(X86)'] || '',
              'Google/Chrome/Application/chrome.exe',
            ),
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isFile()) {
        await fs.access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return candidate;
      }
    } catch {
      /* next installed location */
    }
  }
  throw new Error(
    'No se encuentra Google Chrome. Instálalo en tu carpeta de aplicaciones y vuelve a detectar las aplicaciones.',
  );
}

type DownloadStarted = { frameId: string; guid: string; url: string; suggestedFilename: string };
type DownloadProgress = {
  guid: string;
  receivedBytes: number;
  totalBytes: number;
  state: 'inProgress' | 'completed' | 'canceled';
  filePath?: string;
};
type FrameTree = { frame: { id: string }; childFrames?: FrameTree[] };
type Connection = {
  state: ChromeConnection;
  browser?: Browser;
  context?: BrowserContext;
  downloadSession?: CDPSession;
  staging?: string;
  generation: number;
  task?: Promise<void>;
  stopTask?: Promise<void>;
  stopping?: boolean;
  initializing?: boolean;
};
type PendingDialog = { accept(promptText?: string): Promise<void>; dismiss(): Promise<void> };
type Tab = {
  page: Page;
  state: BrowserState;
  connection: Connection;
  sequence: number;
  frames: Set<string>;
  cdp?: CDPSession;
  cdpTask?: Promise<CDPSession>;
  cdpReady?: boolean;
  world?: number;
  dialog?: PendingDialog;
  modalWaiters: Set<(value: unknown) => void>;
  queue?: Promise<unknown>;
  handlers: (() => void)[];
};
type SavedDownload = {
  state: BrowserDownload;
  guid: string;
  connection: Connection;
  finishing?: boolean;
};
type Options = {
  root: string;
  downloadsRoot: string;
  changed: () => void;
  projectRoot?: (projectId: string, sessionId?: string) => Promise<string>;
  executablePath?: string;
  headless?: boolean;
  personalProfile?: string;
};

/** An external browser owns its own native window. Only Chrome-managed pages enter this backend. */
export class ChromeBrowser {
  private links = new Map<string, Connection>();
  private tabs = new Map<string, Tab>();
  private downloads = new Map<string, SavedDownload>();
  private downloadProgress = new Map<string, DownloadProgress>();
  private closing = false;
  private savedMetadata = '';
  constructor(private options: Options) {
    try {
      const saved: unknown = JSON.parse(
        readFileSync(path.join(options.root, 'chrome-connections.json'), 'utf8'),
      );
      if (Array.isArray(saved))
        for (const value of saved.slice(0, 30)) {
          if (
            !value ||
            typeof value !== 'object' ||
            !['personal', 'managed'].includes(value.mode) ||
            typeof value.id !== 'string' ||
            !/^chrome-[\da-f-]{36}$/.test(value.id) ||
            (value.projectId !== undefined &&
              (typeof value.projectId !== 'string' || value.projectId.length > 150)) ||
            (value.sessionId !== undefined &&
              (typeof value.sessionId !== 'string' || value.sessionId.length > 150))
          )
            continue;
          const state: ChromeConnection = {
            id: value.id,
            mode: value.mode,
            projectId: value.projectId,
            sessionId: value.sessionId,
            status: 'disconnected',
            tabCount: 0,
          };
          this.links.set(state.id, { state, generation: 0 });
        }
    } catch {
      /* Missing or old metadata never starts a browser or blocks the editor. */
    }
  }
  connections() {
    return [...this.links.values()].map(({ state }) => ({
      ...state,
      tabCount: [...this.tabs.values()].filter((tab) => tab.connection.state.id === state.id)
        .length,
    }));
  }
  snapshot() {
    return [...this.tabs.values()].map((tab) => ({
      ...tab.state,
      downloads: this.downloadSnapshot().filter((download) => download.tabId === tab.state.id),
    }));
  }
  downloadSnapshot() {
    return [...this.downloads.values()].map(({ state }) => ({ ...state })).reverse();
  }
  owns(id: string) {
    return this.tabs.has(id);
  }
  private changed() {
    try {
      const metadata = JSON.stringify(
        [...this.links.values()].map(({ state: { id, mode, projectId, sessionId } }) => ({
          id,
          mode,
          projectId,
          sessionId,
        })),
      );
      if (metadata !== this.savedMetadata) {
        mkdirSync(this.options.root, { recursive: true, mode: 0o700 });
        const file = path.join(this.options.root, 'chrome-connections.json');
        writeFileSync(file + '.tmp', metadata, { mode: 0o600 });
        renameSync(file + '.tmp', file);
        this.savedMetadata = metadata;
      }
    } catch {
      /* A disk error must not interrupt an active control connection. */
    }
    if (!this.closing) this.options.changed();
  }
  async connect(mode: ChromeMode, projectId?: string, sessionId?: string) {
    if (this.closing) throw new Error('El editor se está cerrando.');
    if (!['personal', 'managed'].includes(mode)) throw new Error('Modo de Chrome inválido.');
    let link = [...this.links.values()].find(
      ({ state }) => state.mode === mode && state.projectId === projectId,
    );
    if (mode === 'personal') {
      const other = [...this.links.values()].find(
        ({ state }) =>
          state.mode === 'personal' &&
          state.projectId !== projectId &&
          ['connected', 'connecting'].includes(state.status),
      );
      if (other)
        throw new Error(
          'Tu Chrome está conectado a otro proyecto. Desconéctalo allí antes de compartirlo con este proyecto.',
        );
    }
    if (!link) {
      link = {
        state: {
          id: `chrome-${randomUUID()}`,
          mode,
          projectId,
          sessionId,
          status: 'disconnected',
          tabCount: 0,
        },
        generation: 0,
      };
      this.links.set(link.state.id, link);
    }
    if (link.stopTask) await link.stopTask;
    if (this.closing) throw new Error('El editor se está cerrando.');
    if (!this.links.has(link.state.id))
      throw new Error('El proyecto de esta conexión se ha quitado.');
    if (
      mode === 'personal' &&
      [...this.links.values()].some(
        (other) =>
          other !== link &&
          other.state.mode === 'personal' &&
          ['connected', 'connecting'].includes(other.state.status),
      )
    )
      throw new Error('Tu Chrome ya está conectado a otro proyecto. Desconéctalo allí primero.');
    if (link.state.status === 'connected') return;
    if (link.task) return link.task;
    link.state.sessionId = sessionId;
    link.task = this.start(link);
    try {
      await link.task;
    } finally {
      link.task = undefined;
    }
  }
  private async start(link: Connection) {
    const generation = ++link.generation;
    const state = link.state;
    state.status = 'connecting';
    state.error = undefined;
    link.stopping = false;
    link.initializing = true;
    this.changed();
    let context: BrowserContext | undefined;
    let browser: Browser | undefined;
    try {
      state.executable = await installedChrome(this.options.executablePath);
      if (state.mode === 'managed') {
        const key = createHash('sha256')
          .update(state.projectId || 'personal-workspace')
          .digest('hex')
          .slice(0, 24);
        state.profilePath = path.join(this.options.root, 'chrome-profiles', key);
        await fs.mkdir(state.profilePath, { recursive: true, mode: 0o700 });
        context = await chromium.launchPersistentContext(state.profilePath, {
          executablePath: state.executable,
          headless: this.options.headless ?? false,
          viewport: null,
          acceptDownloads: true,
          chromiumSandbox: true,
          timeout: 25000,
          args: ['--no-first-run', '--no-default-browser-check'],
        });
        browser = context.browser() || undefined;
      } else {
        const directory = this.options.personalProfile || chromeProfileDirectory();
        let activePort: string;
        try {
          const file = path.join(directory, 'DevToolsActivePort');
          if ((await fs.stat(file)).size > 4096)
            throw new Error('El descriptor de Chrome es demasiado grande.');
          activePort = await fs.readFile(file, 'utf8');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EACCES')
            throw new Error(
              'El sistema no permite leer la conexión de Chrome. Revisa el permiso de Agent Desk en Privacidad y seguridad, o usa Chrome gestionado.',
            );
          throw new Error(
            'Abre Chrome 144 o posterior y activa la depuración remota en chrome://inspect/#remote-debugging. Después pulsa Conectar y acepta la solicitud en Chrome.',
          );
        }
        browser = await chromium.connectOverCDP(chromeEndpoint(activePort), {
          noDefaults: true,
          isLocal: true,
          timeout: 45000,
        });
        context = browser.contexts()[0];
        if (!context) throw new Error('Chrome no compartió ninguna sesión de navegación.');
      }
      if (link.generation !== generation || this.closing) {
        if (state.mode === 'managed') await context.close();
        else await browser?.close();
        return;
      }
      link.browser = browser;
      link.context = context;
      context.setDefaultTimeout(15000);
      context.setDefaultNavigationTimeout(20000);
      context.on('page', (page) => {
        if (!link.stopping) this.addPage(link, page);
      });
      context.on('close', () => this.lost(link, generation));
      browser?.on('disconnected', () => this.lost(link, generation));
      for (const page of context.pages()) this.addPage(link, page);
      if (!context.pages().length && state.mode === 'managed')
        this.addPage(link, await context.newPage());
      await this.prepareDownloads(link);
      if (link.generation !== generation || this.closing) {
        if (state.mode === 'managed') await context.close();
        else await browser?.close();
        return;
      }
      state.status = 'connected';
      state.connectedAt = Date.now();
      link.initializing = false;
      this.changed();
    } catch (error) {
      if (context && state.mode === 'managed') await context.close().catch(() => {});
      else await browser?.close().catch(() => {});
      if (link.generation !== generation) return;
      for (const [id, tab] of this.tabs) if (tab.connection === link) this.releaseTab(id);
      link.context = undefined;
      link.browser = undefined;
      link.downloadSession = undefined;
      state.status = 'error';
      const detail = (error as Error).message;
      state.error =
        state.mode === 'personal' && /Timeout|ECONNREFUSED|WebSocket|socket|closed/i.test(detail)
          ? 'No se completó la conexión. Comprueba que Chrome siga abierto, que la depuración remota esté activa y acepta la solicitud de control en Chrome. Pulsa Reconectar para reintentar.'
          : detail.slice(0, 1200);
      link.initializing = false;
      this.changed();
      throw new Error(state.error);
    }
  }
  private lost(link: Connection, generation: number) {
    if (generation !== link.generation || link.stopping) return;
    link.state.status = 'disconnected';
    link.state.error = 'La conexión con Chrome se ha interrumpido. Pulsa Reconectar.';
    for (const [id, tab] of this.tabs) if (tab.connection === link) this.releaseTab(id);
    link.context = undefined;
    link.browser = undefined;
    link.downloadSession = undefined;
    this.stopDownloadTracking(link);
    this.changed();
  }
  private addPage(link: Connection, page: Page) {
    const previous = [...this.tabs.values()].find((tab) => tab.page === page);
    if (previous) return previous;
    const tab: Tab = {
      page,
      connection: link,
      sequence: 0,
      frames: new Set(),
      modalWaiters: new Set(),
      handlers: [],
      state: {
        id: `chrome-tab-${randomUUID()}`,
        backend: 'chrome',
        connectionId: link.state.id,
        projectId: link.state.projectId,
        sessionId: link.state.sessionId || '',
        zoom: 1,
        url: page.url(),
        title: 'Chrome',
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
    };
    this.tabs.set(tab.state.id, tab);
    const update = () => {
      void this.updateTab(tab);
    };
    const navigation = () => {
      tab.world = undefined;
      tab.state.loading = false;
      update();
    };
    const closed = () => {
      this.releaseTab(tab.state.id);
      this.changed();
    };
    const dialog = (value: Dialog) => {
      // A listener prevents Playwright auto-dismissal. CDP supplies ordered open/close
      // events, including dialogs the user answers directly in the Chrome window.
      if (!tab.cdpReady)
        this.openedDialog(tab, value, {
          type: value.type(),
          message: value.message(),
          url: page.url(),
          defaultPrompt: value.defaultValue(),
        });
    };
    page.on('framenavigated', navigation);
    page.on('domcontentloaded', update);
    page.on('close', closed);
    page.on('dialog', dialog);
    tab.handlers.push(() => {
      page.off('framenavigated', navigation);
      page.off('domcontentloaded', update);
      page.off('close', closed);
      page.off('dialog', dialog);
    });
    update();
    this.changed();
    return tab;
  }
  private async updateTab(tab: Tab) {
    if (!this.tabs.has(tab.state.id) || tab.page.isClosed()) return;
    tab.state.url = tab.page.url();
    // Subscribe to native dialog closures before evaluating page code, which can
    // otherwise wait indefinitely behind an immediately opened modal.
    const client = await this.cdp(tab).catch(() => undefined);
    if (!tab.dialog) tab.state.title = await tab.page.title().catch(() => 'Chrome');
    if (!tab.dialog) {
      try {
        const history = await client?.send('Page.getNavigationHistory');
        if (history) {
          tab.state.canGoBack = history.currentIndex > 0;
          tab.state.canGoForward = history.currentIndex < history.entries.length - 1;
        }
      } catch {
        /* a navigating or closing tab has no history yet */
      }
    }
    this.changed();
  }
  private releaseTab(id: string) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.tabs.delete(id);
    for (const cleanup of tab.handlers) cleanup();
    for (const expose of tab.modalWaiters)
      expose({ ok: false, error: 'Se ha desconectado la pestaña.' });
    tab.modalWaiters.clear();
    // Detaching never closes a page belonging to the user's personal Chrome.
    void tab.cdp?.detach().catch(() => {});
  }
  private async cdp(tab: Tab) {
    if (!this.tabs.has(tab.state.id)) throw new Error('La pestaña ya no está conectada.');
    if (tab.cdpReady && tab.cdp) return tab.cdp;
    if (!tab.cdpTask)
      tab.cdpTask = (async () => {
        const client = await tab.page.context().newCDPSession(tab.page);
        if (!this.tabs.has(tab.state.id)) {
          await client.detach();
          throw new Error('La pestaña ya no está conectada.');
        }
        tab.cdp = client;
        client.on('Page.frameAttached', ({ frameId }) => tab.frames.add(frameId));
        client.on('Page.frameDetached', ({ frameId }) => tab.frames.delete(frameId));
        client.on('Page.javascriptDialogOpening', (event) =>
          this.openedDialog(
            tab,
            {
              accept: (promptText) =>
                client
                  .send('Page.handleJavaScriptDialog', { accept: true, promptText })
                  .then(() => {}),
              dismiss: () =>
                client.send('Page.handleJavaScriptDialog', { accept: false }).then(() => {}),
            },
            event,
          ),
        );
        client.on('Page.javascriptDialogClosed', () => {
          tab.dialog = undefined;
          tab.state.dialog = undefined;
          this.changed();
        });
        await client.send('Page.enable');
        const { frameTree } = await client.send('Page.getFrameTree');
        const remember = (tree: FrameTree) => {
          tab.frames.add(tree.frame.id);
          for (const child of tree.childFrames || []) remember(child);
        };
        remember(frameTree);
        tab.cdpReady = true;
        return client;
      })();
    try {
      return await tab.cdpTask;
    } finally {
      tab.cdpTask = undefined;
    }
  }
  private async world(tab: Tab) {
    const client = await this.cdp(tab);
    if (!tab.world) {
      const { frameTree } = await client.send('Page.getFrameTree');
      const { executionContextId } = await client.send('Page.createIsolatedWorld', {
        frameId: frameTree.frame.id,
        worldName: 'agent-desk-chrome',
      });
      tab.world = executionContextId;
    }
    return tab.world;
  }
  private async evaluate(tab: Tab, expression: string) {
    const contextId = await this.world(tab);
    const result = await (
      await this.cdp(tab)
    ).send('Runtime.evaluate', { expression, contextId, returnByValue: true, userGesture: true });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description || result.exceptionDetails.text,
      );
    return result.result.value;
  }
  private async dom(tab: Tab, input: Parameters<typeof browserDOM>[0]) {
    if (!['inspect', 'viewport', 'scroll'].includes(input.action)) {
      const scale = await this.evaluate(tab, 'window.visualViewport?.scale || 1');
      if (Math.abs(scale - 1) > 0.01)
        throw new Error(
          'La página usa zoom táctil. Restablécelo en Chrome antes de interactuar con elementos para mantener las coordenadas exactas.',
        );
    }
    // tsx's keepNames transform can reference this helper when running diagnostics.
    return this.evaluate(
      tab,
      `(()=>{const __name=(fn)=>fn;return (${browserDOM.toString()})(${JSON.stringify(input)});})()`,
    );
  }
  private modalResult(tab: Tab) {
    return {
      ok: false,
      url: tab.state.url,
      title: tab.state.title,
      text: 'Responde al diálogo de Chrome antes de continuar.',
      elements: [],
      dialog: tab.state.dialog,
    };
  }
  private openedDialog(
    tab: Tab,
    dialog: PendingDialog,
    info: { type: string; message: string; url: string; defaultPrompt?: string },
  ) {
    if (!this.tabs.has(tab.state.id)) return;
    tab.dialog = dialog;
    tab.state.dialog = {
      id: randomUUID(),
      type: info.type as 'alert' | 'confirm' | 'prompt' | 'beforeunload',
      message: info.message.slice(0, 12000),
      url: info.url,
      defaultPrompt: info.defaultPrompt,
    };
    for (const expose of tab.modalWaiters) expose(this.modalResult(tab));
    this.changed();
  }
  async newTab(connectionId: string, url?: string) {
    const link = this.links.get(connectionId);
    if (!link?.context || link.state.status !== 'connected')
      throw new Error('Conecta Chrome antes de abrir una pestaña.');
    if (url) browserURL(url);
    const tab = this.addPage(link, await link.context.newPage());
    if (url) await this.action(tab.state.id, { action: 'navigate', url });
    return { ...tab.state };
  }
  async focus(id: string) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error('La pestaña de Chrome ya no está conectada.');
    await tab.page.bringToFront();
  }
  async forSession(sessionId: string, projectId: string, input: unknown) {
    const args = browserInput.parse(input);
    const available = this.snapshot().filter((tab) => tab.projectId === projectId);
    if (args.action === 'list') return { tabs: available };
    const tab = args.tabId
      ? available.find((tab) => tab.id === args.tabId)
      : available.find((tab) => tab.sessionId === sessionId) || available[0];
    if (!tab) throw new Error('Selecciona una pestaña de Chrome conectada a este proyecto.');
    return this.action(tab.id, args, sessionId);
  }
  action(id: string, input: unknown, sessionId?: string): Promise<any> {
    const args = browserInput.parse(input);
    const tab = this.tabs.get(id);
    if (!tab) return Promise.reject(new Error('La pestaña de Chrome ya no está conectada.'));
    if (args.action === 'dialog') return this.respondDialog(tab, args);
    if (args.action === 'downloads')
      return Promise.resolve({
        ok: true,
        downloads: this.downloadSnapshot().filter((download) => download.tabId === id),
        ...(tab.connection.state.mode === 'personal'
          ? {
              message:
                'Las descargas mantienen la ubicación y las preferencias de Chrome. Se muestra el progreso de las iniciadas durante esta conexión.',
            }
          : {}),
      });
    if (args.action === 'downloadControl')
      return this.controlDownload(id, args.downloadId, args.operation);
    if (tab.dialog) return Promise.resolve(this.modalResult(tab));
    let expose!: (value: unknown) => void, reject!: (error: unknown) => void;
    const response = new Promise((resolve, failure) => {
      expose = resolve;
      reject = failure;
    });
    const next = (tab.queue || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (!this.tabs.has(id)) throw new Error('La pestaña ya no está conectada.');
        if (tab.dialog) {
          expose(this.modalResult(tab));
          return;
        }
        tab.state.activity = { action: args.action, phase: 'running', at: Date.now(), sessionId };
        tab.modalWaiters.add(expose);
        this.changed();
        try {
          const value = await this.perform(tab, args, sessionId);
          tab.state.activity = { ...tab.state.activity, phase: 'done', at: Date.now() };
          expose(value);
        } catch (error) {
          tab.state.activity = {
            ...tab.state.activity,
            phase: 'error',
            error: (error as Error).message,
            at: Date.now(),
          };
          reject(error);
        } finally {
          tab.modalWaiters.delete(expose);
          this.changed();
        }
      });
    tab.queue = next;
    void next.catch(reject).finally(() => {
      if (tab.queue === next) tab.queue = undefined;
    });
    return response;
  }
  private async respondDialog(tab: Tab, args: Extract<BrowserInput, { action: 'dialog' }>) {
    if (!tab.dialog || tab.state.dialog?.id !== args.dialogId)
      throw new Error('El diálogo ya no está pendiente.');
    const dialog = tab.dialog;
    try {
      if (args.accept) await dialog.accept(args.promptText);
      else await dialog.dismiss();
    } catch (error) {
      throw new Error(`No se pudo responder al diálogo: ${(error as Error).message}`);
    } finally {
      if (tab.dialog === dialog) {
        tab.dialog = undefined;
        tab.state.dialog = undefined;
      }
      this.changed();
    }
    return { ok: true };
  }
  private async perform(tab: Tab, args: BrowserInput, sessionId?: string): Promise<any> {
    const page = tab.page;
    if (args.action === 'list')
      return { tabs: this.snapshot().filter((item) => item.projectId === tab.state.projectId) };
    if (args.action === 'new') return this.newTab(tab.connection.state.id, args.url);
    if (args.action === 'close') {
      await page.close({ runBeforeUnload: true });
      return tab.dialog ? this.modalResult(tab) : { ok: true, closing: true };
    }
    if (args.action === 'suspend')
      throw new Error('Usa Desconectar para detener el control de Chrome conservando tu sesión.');
    if (args.action === 'navigate') {
      tab.state.loading = true;
      tab.state.error = undefined;
      this.changed();
      try {
        await page.goto(browserURL(args.url), { waitUntil: 'domcontentloaded' });
      } catch (error) {
        if (!/Download is starting/i.test((error as Error).message)) throw error;
      } finally {
        tab.state.loading = false;
        await this.updateTab(tab);
      }
      return { ok: true, ...tab.state };
    }
    if (
      !/^https?:\/\//i.test(page.url()) &&
      page.url() !== 'about:blank' &&
      !page.url().startsWith('blob:')
    )
      throw new Error(
        'Las páginas internas de Chrome se gestionan manualmente. Navega a una dirección http o https para continuar.',
      );
    if (args.action === 'back') await page.goBack({ waitUntil: 'domcontentloaded' });
    else if (args.action === 'forward') await page.goForward({ waitUntil: 'domcontentloaded' });
    else if (args.action === 'reload') await page.reload({ waitUntil: 'domcontentloaded' });
    else if (args.action === 'inspect')
      return {
        ok: true,
        ...(await this.dom(tab, { action: 'inspect', sequence: ++tab.sequence })),
      };
    else if (args.action === 'screenshot') {
      const { data } = await (
        await this.cdp(tab)
      ).send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const viewport = await this.dom(tab, { action: 'viewport' });
      const png = Buffer.from(data, 'base64');
      const imageSize = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
      return { ok: true, image: data, mimeType: 'image/png', viewport, imageSize };
    } else if (args.action === 'zoom') {
      throw new Error(
        'Ajusta el zoom de Chrome desde su menú o teclado. El control remoto no cambia el zoom del navegador.',
      );
    } else if (args.action === 'upload') {
      const root =
        tab.state.projectId && this.options.projectRoot
          ? await this.options.projectRoot(tab.state.projectId, sessionId || tab.state.sessionId)
          : undefined;
      const files = await browserUploadPaths(args.paths, root);
      const client = await this.cdp(tab);
      const value = await client.send('Runtime.evaluate', {
        contextId: await this.world(tab),
        expression: `(()=>{const e=window.__deskAutomation?.elements.get(${JSON.stringify(args.ref)});if(!e?.isConnected)throw new Error('Referencia caducada. Vuelve a inspeccionar.');if(e.tagName!=='INPUT'||e.type!=='file'||e.disabled||e.webkitdirectory)throw new Error('Selecciona un campo de archivo habilitado.');if(!e.multiple&&${files.length}>1)throw new Error('Este campo admite un solo archivo.');return e;})()`,
      });
      if (value.exceptionDetails || !value.result.objectId)
        throw new Error(
          value.exceptionDetails?.exception?.description || 'No se encuentra el campo de archivo.',
        );
      try {
        await client.send('DOM.setFileInputFiles', {
          objectId: value.result.objectId,
          files: files.map((file) => file.path),
        });
      } finally {
        await client
          .send('Runtime.releaseObject', { objectId: value.result.objectId })
          .catch(() => {});
      }
      return { ok: true, files: files.map(({ name, size }) => ({ name, size })) };
    } else if (args.action === 'download') {
      const url = new URL(args.url);
      if (url.protocol === 'blob:') {
        if (url.origin !== new URL(page.url()).origin)
          throw new Error('El Blob debe pertenecer a esta página.');
      } else browserURL(args.url);
      await this.evaluate(
        tab,
        `(()=>{const a=document.createElement('a');a.href=${JSON.stringify(url.href)};a.download='';a.rel='noopener';a.target='_blank';document.documentElement.append(a);a.click();a.remove();return true;})()`,
      );
      return {
        ok: true,
        message:
          tab.connection.state.mode === 'personal'
            ? 'Descarga solicitada. Consulta downloads para comprobar el progreso; Chrome puede pedir dónde guardar el archivo.'
            : 'Descarga solicitada. Consulta downloads para comprobar el resultado.',
      };
    } else if (args.action === 'fill' || args.action === 'select') {
      const result = await this.dom(tab, args);
      if (typeof result.insertText === 'string') await page.keyboard.insertText(result.insertText);
    } else if (args.action === 'scroll') await this.dom(tab, args);
    else if (args.action === 'press') {
      const names = { control: 'Control', meta: 'Meta', alt: 'Alt', shift: 'Shift' };
      await page.keyboard.press(
        [
          ...(args.modifiers || []).map((key) => names[key]),
          args.key === 'Space' ? ' ' : args.key,
        ].join('+'),
      );
    } else if (args.action === 'check') {
      const target = await this.dom(tab, args);
      if (target.needsClick) await page.mouse.click(target.x, target.y);
      if (!tab.dialog && (await this.dom(tab, args)).needsClick)
        throw new Error('La casilla no cambió al estado solicitado.');
      return { ok: true, checked: args.checked };
    } else if (args.action === 'click' || args.action === 'hover' || args.action === 'move') {
      const target = await this.dom(tab, { ...args, action: 'point' });
      if (tab.state.activity) tab.state.activity.label = target.label;
      this.changed();
      await page.mouse.move(target.x, target.y, { steps: 6 });
      if (args.action === 'click')
        await page.mouse.click(target.x, target.y, {
          button: args.button,
          clickCount: args.clickCount,
        });
    } else if (args.action === 'drag') {
      await this.dom(tab, { action: 'point', ref: args.ref, x: args.x, y: args.y });
      await this.dom(tab, { action: 'point', ref: args.toRef, x: args.toX, y: args.toY });
      const source = await this.dom(tab, {
        action: 'point',
        ref: args.ref,
        x: args.x,
        y: args.y,
        scrollIntoView: false,
      });
      const target = await this.dom(tab, {
        action: 'point',
        ref: args.toRef,
        x: args.toX,
        y: args.toY,
        scrollIntoView: false,
      });
      await page.mouse.move(source.x, source.y);
      await page.mouse.down();
      try {
        await page.mouse.move(target.x, target.y, { steps: 12 });
      } finally {
        await page.mouse.up().catch(() => {});
      }
    }
    await this.updateTab(tab);
    return tab.dialog ? this.modalResult(tab) : { ok: true, ...tab.state };
  }
  private async prepareDownloads(link: Connection) {
    if (!link.browser) throw new Error('No se pudo conectar el gestor de descargas de Chrome.');
    const client = await link.browser.newBrowserCDPSession();
    link.downloadSession = client;
    client.on('Browser.downloadWillBegin', (event) => {
      void this.beginDownload(link, event);
    });
    client.on('Browser.downloadProgress', (event) => {
      const entry = [...this.downloads.values()].find(
        (item) => item.guid === event.guid && item.connection === link,
      );
      if (entry) void this.updateDownload(entry, event);
      else {
        this.downloadProgress.set(event.guid, event);
        if (this.downloadProgress.size > 250)
          this.downloadProgress.delete(this.downloadProgress.keys().next().value!);
      }
    });
    if (link.state.mode === 'managed') {
      link.staging = path.join(this.options.downloadsRoot, '.chrome-staging', link.state.id);
      await fs.mkdir(link.staging, { recursive: true, mode: 0o700 });
      await client.send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath: link.staging,
        eventsEnabled: true,
      });
    } else {
      // 'default' preserves Chrome's own download directory and ask-where-to-save
      // preference. Only native progress events are enabled; files are never copied.
      await client.send('Browser.setDownloadBehavior', {
        behavior: 'default',
        eventsEnabled: true,
      });
    }
  }
  private async beginDownload(link: Connection, event: DownloadStarted) {
    let tab = [...this.tabs.values()].find(
      (item) => item.connection === link && item.frames.has(event.frameId),
    );
    if (!tab) {
      await Promise.allSettled(
        [...this.tabs.values()]
          .filter((item) => item.connection === link)
          .map((item) => this.cdp(item)),
      );
      tab = [...this.tabs.values()].find(
        (item) => item.connection === link && item.frames.has(event.frameId),
      );
    }
    if (!tab || link.stopping) return;
    const state: BrowserDownload = {
      id: `chrome-download-${randomUUID()}`,
      tabId: tab.state.id,
      projectId: tab.state.projectId,
      sessionId: tab.state.sessionId,
      fileName: downloadFilename(event.suggestedFilename),
      state: 'progress',
      receivedBytes: 0,
      totalBytes: 0,
      startedAt: Date.now(),
      canResume: false,
      canPause: false,
      canCancel: true,
    };
    const entry: SavedDownload = { state, guid: event.guid, connection: link };
    this.downloads.set(state.id, entry);
    const progress = this.downloadProgress.get(event.guid);
    this.downloadProgress.delete(event.guid);
    if (progress) await this.updateDownload(entry, progress);
    while (this.downloads.size > 200) {
      const old = [...this.downloads.entries()].find(([, item]) => item.state.state !== 'progress');
      if (!old) break;
      this.downloads.delete(old[0]);
    }
    this.changed();
  }
  private async updateDownload(entry: SavedDownload, event: DownloadProgress) {
    const state = entry.state;
    if (entry.finishing || state.state !== 'progress') return;
    state.receivedBytes = Math.max(0, event.receivedBytes);
    state.totalBytes = Math.max(0, event.totalBytes);
    if (event.state === 'canceled') state.state = 'cancelled';
    else if (event.state === 'completed') {
      entry.finishing = true;
      try {
        if (entry.connection.state.mode === 'managed') {
          // Chrome writes GUID filenames to our private staging folder. A unique
          // destination prevents a web filename from overwriting existing files.
          const source = path.join(entry.connection.staging!, entry.guid);
          const folder = path.join(this.options.downloadsRoot, state.id);
          await fs.mkdir(folder, { recursive: true, mode: 0o700 });
          const destination = path.join(folder, state.fileName);
          await fs.rename(source, destination);
          state.path = destination;
        } else if (event.filePath && path.isAbsolute(event.filePath)) {
          // This field is optional in CDP; never infer a path from the web filename.
          const stat = await fs.stat(event.filePath).catch(() => undefined);
          if (stat?.isFile()) state.path = event.filePath;
        }
        state.state = 'completed';
      } catch (error) {
        state.state = 'interrupted';
        state.error = `Chrome completó la transferencia, pero no se pudo guardar el archivo: ${(error as Error).message}`;
      }
    }
    this.changed();
  }
  async controlDownload(tabId: string, id: string, operation: 'pause' | 'resume' | 'cancel') {
    const entry = this.downloads.get(id);
    if (!entry || entry.state.tabId !== tabId)
      throw new Error('No se encuentra esa descarga de Chrome.');
    if (operation !== 'cancel')
      throw new Error(
        'Chrome permite cancelar esta descarga; pausar y reanudar se gestiona desde su panel nativo.',
      );
    if (entry.state.state !== 'progress') throw new Error('La descarga ya no está en curso.');
    if (!entry.connection.downloadSession)
      throw new Error('Reconecta Chrome para gestionar esta descarga.');
    await entry.connection.downloadSession.send('Browser.cancelDownload', { guid: entry.guid });
    entry.state.state = 'cancelled';
    this.changed();
    return { ok: true };
  }
  async revealDownload(tabId: string, id: string) {
    const entry = this.downloads.get(id);
    if (
      !entry ||
      entry.state.tabId !== tabId ||
      entry.state.state !== 'completed' ||
      !entry.state.path
    )
      throw new Error('La descarga no está guardada.');
    await fs.access(entry.state.path);
    return entry.state.path;
  }
  async disconnect(id: string) {
    const link = this.links.get(id);
    if (!link) throw new Error('La conexión de Chrome ya no existe.');
    if (link.stopTask) return link.stopTask;
    const task = this.stopLink(link);
    link.stopTask = task;
    try {
      await task;
    } finally {
      if (link.stopTask === task) link.stopTask = undefined;
    }
  }
  private async stopLink(link: Connection) {
    const pending = link.task;
    ++link.generation;
    link.stopping = true;
    const browser = link.browser,
      context = link.context,
      downloads = link.downloadSession;
    link.browser = undefined;
    link.context = undefined;
    link.downloadSession = undefined;
    for (const [tabId, tab] of this.tabs) if (tab.connection === link) this.releaseTab(tabId);
    link.state.status = 'disconnected';
    link.state.error = undefined;
    this.changed();
    // Playwright connectOverCDP Browser.close closes its transport only. Context.close
    // would close the real user's browser and is deliberately never used for personal mode.
    if (downloads && link.state.mode === 'personal')
      await downloads
        .send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: false })
        .catch(() => {});
    try {
      if (link.state.mode === 'managed') await context?.close();
      else await browser?.close();
    } finally {
      await pending?.catch(() => {});
      this.stopDownloadTracking(link);
      this.changed();
    }
  }
  async reconnect(id: string) {
    const link = this.links.get(id);
    if (!link) throw new Error('La conexión de Chrome ya no existe.');
    await this.disconnect(id);
    return this.connect(link.state.mode, link.state.projectId, link.state.sessionId);
  }
  async removeSessions(sessionIds: string[]) {
    for (const link of this.links.values())
      if (link.state.sessionId && sessionIds.includes(link.state.sessionId)) {
        await this.disconnect(link.state.id);
        link.state.sessionId = undefined;
      }
    this.changed();
  }
  async removeProject(projectId: string, _sessionIds: string[] = []) {
    for (const link of this.links.values())
      if (link.state.projectId === projectId) {
        await this.disconnect(link.state.id);
        this.links.delete(link.state.id);
      }
    this.changed();
  }
  private stopDownloadTracking(link: Connection) {
    for (const entry of this.downloads.values())
      if (entry.connection === link && entry.state.state === 'progress' && !entry.finishing) {
        entry.state.canCancel = false;
        entry.state.state = 'interrupted';
        entry.state.error =
          link.state.mode === 'personal'
            ? 'El seguimiento se ha detenido. Comprueba el resultado en Chrome.'
            : 'Se ha cerrado Chrome antes de completar la descarga.';
      }
  }
  async closeAll() {
    this.closing = true;
    await Promise.allSettled([...this.links.keys()].map((id) => this.disconnect(id)));
  }
}
