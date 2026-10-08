import { ProxySettings } from './proxy';
import { safeStorage, session as electronSession } from 'electron';
import { Attachments } from './attachments';
import { nativeImage } from 'electron';
import { DeskBrowser } from './browser';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Manager } from './manager';
import { actionSchema } from './core';
import { opensAsText, resolveProjectPath, searchProjectFiles } from './project-files';
import { readTheme, writeTheme } from './appearance';
import { IPC_VERSION } from '../src/runtime';
app.setName('Agent Desk');
if (process.env.AGENT_DESK_DATA_DIR)
  app.setPath('userData', path.resolve(process.env.AGENT_DESK_DATA_DIR));
const attachments = new Attachments(path.join(app.getPath('userData'), 'attachments'), (data) => {
  const image = nativeImage.createFromBuffer(data);
  if (image.isEmpty()) throw new Error('No se puede abrir esta imagen.');
  const { width, height } = image.getSize();
  if (width > 12000 || height > 12000)
    throw new Error('La imagen es demasiado grande (máximo 12000 px por lado).');
  return image.resize({ width: Math.min(240, width) }).toDataURL();
});
let browser: DeskBrowser,
  manager: Manager,
  win: BrowserWindow | undefined,
  quitting = false;
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});
const dev = process.env.AGENT_DESK_DEV_URL;
const observedBrowserOutputs = new Set<string>();
let network: ProxySettings;
const networkSessions = new Set<Electron.Session>();
const networkReady = new WeakMap<Electron.Session, Promise<void>>();
let savingNetwork = false;
let testingNetwork = false;
function configureNetwork(ses: Electron.Session, reset = false) {
  networkSessions.add(ses);
  const work = (async () => {
    await ses.setProxy(network.browserConfig());
    if (reset) {
      await ses.clearAuthCache();
      await ses.closeAllConnections();
    }
  })();
  networkReady.set(ses, work);
  void work.catch(() => {});
  return work;
}
function prepareNetwork(ses: Electron.Session) {
  if (network.snapshot().error) return Promise.reject(new Error(network.snapshot().error));
  return networkReady.get(ses) ?? configureNetwork(ses);
}
function sanitize(value: any, key = ''): any {
  if (typeof value === 'string' && ['error', 'notice', 'unavailable'].includes(key))
    return network?.redact(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => sanitize(v));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v, k)]));
  return value;
}
let updateAvailable = false;
let restartRequested = false;
const snapshot = () =>
  sanitize({
    proxy: network?.snapshot(),
    ...manager.state,
    browsers: browser?.snapshot() ?? [],
    accounts: manager.accounts.state,
    coordination: manager.coordinator.snapshot(),
    terminals: manager.terminals.snapshot(),
    theme: nativeTheme.themeSource,
    runtime: { protocol: IPC_VERSION, updateAvailable, restartSupported: !!dev && !!process.send },
  });
if (dev && process.send)
  process.on('message', (message) => {
    if (message === 'desk:dev-update') {
      updateAvailable = true;
      if (manager) manager.changed();
    } else if (message === 'desk:dev-quit') app.quit();
  });
if (dev && dev !== 'http://127.0.0.1:5173') throw new Error('Origen de desarrollo no permitido');
if (dev) {
  process.on('SIGINT', () => app.quit());
  process.on('SIGTERM', () => app.quit());
}
function trusted(url: string) {
  return dev
    ? url === dev + '/'
    : url === pathToFileURL(path.join(__dirname, '../dist/index.html')).href;
}
async function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: windowBackground(),
    title: 'Agent Desk',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 20 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.on('closed', () => browser?.hide());
  win.webContents.on('did-start-loading', () => browser?.hide());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!trusted(url)) event.preventDefault();
  });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  if (dev) await win.loadURL(dev);
  else await win.loadFile(path.join(__dirname, '../dist/index.html'));
}
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#161616' : '#e9e8e4');
app.whenReady().then(async () => {
  // The chosen theme drives prefers-color-scheme for the app, the terminal and browser tabs.
  nativeTheme.themeSource = readTheme(app.getPath('userData'));
  nativeTheme.on('updated', () => {
    if (win && !win.isDestroyed()) win.setBackgroundColor(windowBackground());
  });
  try {
    network = new ProxySettings(app.getPath('userData'), {
      available: () =>
        safeStorage.isEncryptionAvailable() &&
        (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(value),
    });
    app.on('session-created', (ses) => {
      if (!network.snapshot().error) void configureNetwork(ses).catch(() => {});
    });
    if (!network.snapshot().error) await prepareNetwork(electronSession.defaultSession);
    const authAttempts = new Map<string, { at: number; count: number }>();
    app.on('login', (event, contents, request, auth, callback) => {
      if (!auth.isProxy) return;
      let credentials;
      try {
        credentials = network.credentials(auth.host, auth.port);
      } catch {
        event.preventDefault();
        callback();
        return;
      }
      if (!credentials) return;
      event.preventDefault();
      const key = `${contents?.id}:${request.url}:${auth.host}:${auth.port}`;
      const previous = authAttempts.get(key);
      const count = previous && Date.now() - previous.at < 10000 ? previous.count + 1 : 1;
      if (authAttempts.size > 200) authAttempts.clear();
      authAttempts.set(key, { at: Date.now(), count });
      if (count > 2) callback();
      else callback(credentials.username, credentials.password);
    });
    manager = new Manager(
      app.getPath('userData'),
      (e) => {
        if (browser && manager) {
          if (e.type === 'terminal') {
            const projectId = e.sessionId.startsWith('shell:')
              ? e.sessionId.slice(6)
              : manager.state.sessions.find((s) => s.id === e.sessionId)?.projectId;
            if (projectId) void browser.observe(projectId, e.sessionId, e.data);
          } else if (e.type === 'state') {
            for (const session of e.state.sessions)
              for (const message of session.messages.slice(-10)) {
                const outputs = (message.blocks ?? []).flatMap((b) =>
                  b.type === 'tool_use' && b.name === 'Bash' && b.result
                    ? [{ id: b.id, text: b.result }]
                    : [],
                );
                if (message.role === 'tool' && message.text.startsWith('$ '))
                  outputs.push({ id: message.id, text: message.text });
                for (const output of outputs) {
                  const key = `${session.id}:${output.id}:${output.text.length}`;
                  if (observedBrowserOutputs.has(key)) continue;
                  observedBrowserOutputs.add(key);
                  if (observedBrowserOutputs.size > 3000)
                    observedBrowserOutputs.delete(observedBrowserOutputs.values().next().value!);
                  void browser.observe(session.projectId, session.id, output.text);
                }
              }
          }
        }
        if (win && !win.isDestroyed())
          win.webContents.send('desk:event', e.type === 'state' ? { ...e, state: snapshot() } : e);
      },
      process.env.AGENT_DESK_PROFILES_DIR
        ? path.resolve(process.env.AGENT_DESK_PROFILES_DIR)
        : undefined,
      () => network.environment(),
    );
    browser = new DeskBrowser(
      () => win,
      () => manager.changed(),
      (tabId, sessionId) => {
        if (win && !win.isDestroyed())
          win.webContents.send('desk:event', { type: 'browserOpened', sessionId, tabId });
      },
      app.getPath('userData'),
      prepareNetwork,
    );
    manager.coordinator.browserHandler = (session, input) => {
      if (quitting) return Promise.reject(new Error('Agent Desk se está cerrando.'));
      return browser.forSession(session.id, session.projectId, input);
    };
    await manager.discover();
  } catch (e) {
    dialog.showErrorBox('No se puede abrir Agent Desk', (e as Error).message);
    app.quit();
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Agent Desk',
        submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }],
      },
      {
        label: 'Edición',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'Ventana',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          { role: 'togglefullscreen' },
          { type: 'separator' },
          {
            // Escape hatch when custom CSS leaves the interface unusable.
            label: 'Restablecer estilos de la interfaz',
            click: () =>
              win?.webContents.send('desk:event', { type: 'shortcut', action: 'resetStyles' }),
          },
        ],
      },
    ]),
  );
  ipcMain.handle('desk:action', async (event, input) => {
    try {
      if (
        !win ||
        event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame ||
        !trusted(event.senderFrame.url)
      )
        throw new Error('Origen IPC no permitido.');
      const parsed = actionSchema.safeParse(input);
      if (!parsed.success)
        throw new Error(
          'La solicitud no es compatible o contiene datos inválidos. Reinicia Agent Desk si acabas de actualizarlo.',
        );
      const a = parsed.data;
      if ((restartRequested || quitting) && a.type !== 'snapshot')
        throw new Error('Agent Desk se está reiniciando. Espera a que vuelva a abrirse.');
      switch (a.type) {
        case 'saveProxy': {
          if (savingNetwork) throw new Error('Espera a que termine el guardado de red.');
          savingNetwork = true;
          try {
            network.save(a.config);
            const results = await Promise.allSettled(
              [...networkSessions].map((ses) => configureNetwork(ses, true)),
            );
            manager.networkChanged();
            return {
              ok: true,
              message: results.some((r) => r.status === 'rejected')
                ? 'Configuración guardada. Reinicia la aplicación para aplicarla al navegador.'
                : 'Configuración guardada. Se aplica al navegador y a las nuevas conexiones de cuenta. Detén y vuelve a abrir los agentes que ya estaban en marcha.',
            };
          } finally {
            savingNetwork = false;
          }
        }
        case 'testProxy': {
          if (testingNetwork) throw new Error('Ya hay una prueba de conexión en curso.');
          testingNetwork = true;
          try {
            return await network.test(a.config, a.provider);
          } finally {
            testingNetwork = false;
          }
        }
        case 'detectProxy': {
          const probe = electronSession.fromPartition('desk-system-proxy-detection');
          await networkReady.get(probe)?.catch(() => {});
          await probe.setProxy({ mode: 'system' });
          const resolved = await probe.resolveProxy('https://chatgpt.com');
          const match = resolved.match(/(?:^|;\s*)(PROXY|HTTP|HTTPS) ([^; ]+)/);
          if (!match)
            throw new Error(
              'No se detectó un proxy HTTP/HTTPS. Introduce los datos facilitados por TI.',
            );
          const url = new URL(`${match[1] === 'HTTPS' ? 'https' : 'http'}://${match[2]}`);
          return {
            protocol: url.protocol.slice(0, -1),
            host: url.hostname,
            port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
          };
        }
        case 'chooseProxyCertificate': {
          const result = await dialog.showOpenDialog(win!, {
            title: 'Certificado CA corporativo (PEM)',
            properties: ['openFile'],
            filters: [{ name: 'Certificados PEM', extensions: ['pem', 'crt', 'cer'] }],
          });
          return result.canceled ? undefined : result.filePaths[0];
        }

        case 'setDefaultAccount':
          return manager.setDefaultAccount(a.profile);
        case 'changeSessionAccount':
          return manager.changeSessionAccount(a.sessionId, a.profile);
        case 'addAccount':
          return manager.addAccount(a.kind, a.name);
        case 'removeAccount':
          return manager.removeAccount(a.profile, a.confirmed, (directory) =>
            shell.trashItem(directory),
          );
        case 'accountRefresh':
          return manager.accounts.refresh(a.profile);
        case 'accountCancel':
          return manager.accounts.cancel(a.profile);
        case 'accountLogout':
          return manager.accounts.logout(a.profile, a.stopSessions);
        case 'accountLogin': {
          const url = await manager.accounts.login(a.profile, a.stopSessions);
          if (url) {
            try {
              await shell.openExternal(url);
            } catch (error) {
              await manager.accounts.cancel(a.profile);
              throw error;
            }
          }
          return;
        }
        case 'openProjectTerminal':
          manager.terminals.open(manager.project(a.projectId));
          return;
        case 'openPath': {
          const target = await resolveProjectPath(manager.project(a.projectId).path, a.path);
          if (a.reveal || (!target.directory && !opensAsText(target.path)))
            shell.showItemInFolder(target.path);
          else {
            const failure = await shell.openPath(target.path);
            if (failure) throw new Error(failure);
          }
          return;
        }
        case 'listFiles':
          return searchProjectFiles(manager.project(a.projectId).path, a.query);
        case 'setTheme':
          writeTheme(app.getPath('userData'), a.theme);
          nativeTheme.themeSource = a.theme;
          return;
        case 'browser': {
          const session = manager.session(a.sessionId);
          return browser.forSession(session.id, session.projectId, a.input);
        }
        case 'browserNew': {
          if (a.projectId) manager.project(a.projectId);
          if (a.sessionId) manager.session(a.sessionId);
          const tab = browser.create(a.projectId, a.sessionId, a.url);
          if (a.url) await browser.action(tab.id, { action: 'navigate', url: a.url });
          return tab;
        }
        case 'browserTab':
          if (!browser.snapshot().some((tab) => tab.id === a.tabId))
            throw new Error('La pestaña ya no existe.');
          return browser.action(a.tabId, a.input);
        case 'browserPresent':
          if (a.tabId || a.sessionId)
            browser.present((a.tabId ?? a.sessionId)!, a.bounds, a.visible);
          return;
        case 'snapshot':
          return snapshot();
        case 'restartApp':
          if (!dev || !process.send || !updateAvailable)
            throw new Error('No hay una actualización de desarrollo preparada.');
          if (!manager.canRestart)
            throw new Error(
              'Detén las sesiones abiertas antes de actualizar. Sus procesos siguen activos.',
            );
          // Close through the normal shutdown path; the dev launcher reopens after exit.
          restartRequested = true;
          process.send('desk:dev-restart');
          setImmediate(() => app.quit());
          return;
        case 'addProject': {
          const r = await dialog.showOpenDialog(win, {
            title: 'Añadir proyecto local',
            properties: ['openDirectory'],
          });
          if (!r.canceled) return manager.addProject(r.filePaths[0]);
          return;
        }
        case 'removeProject': {
          await manager.removeProject(a.projectId, async (sessions) => {
            await browser.removeProject(
              a.projectId,
              sessions.map((s) => s.id),
            );
            await attachments.removeSessions(sessions);
            for (const key of observedBrowserOutputs)
              if (sessions.some((s) => key.startsWith(s.id + ':')))
                observedBrowserOutputs.delete(key);
          });
          return;
        }
        case 'select': {
          const previous = manager.state.selectedSession;
          const selected = manager.select(a.projectId, a.sessionId, a.profile);

          return selected;
        }
        case 'newSession':
          return manager.newSession(a.projectId, a.profile, a.mode);
        case 'configure':
          return manager.configure(a.sessionId, a.config);
        case 'refreshCodexModels':
          return manager.refreshCodexModels(a.sessionId);
        case 'refreshModels':
          return manager.refreshModels(a.sessionId);
        case 'configureOptimization':
          return manager.configureOptimization(a.profile, a.optimization);
        case 'configureCodex':
          return manager.configureCodex(a.sessionId, a.config);
        case 'renameProject':
          return manager.renameProject(a.projectId, a.name);
        case 'rename':
          return manager.rename(a.sessionId, a.title);
        case 'setMode':
          return manager.setMode(a.sessionId, a.mode);
        case 'contextUsage':
          return manager.contextUsage(a.sessionId);
        case 'chooseDirectory': {
          const r = await dialog.showOpenDialog(win, {
            title: 'Añadir directorio adicional',
            properties: ['openDirectory'],
          });
          if (r.canceled) return;
          const s = manager.session(a.sessionId);
          const dirs = [...(s.config?.additionalDirectories ?? [])];
          if (!dirs.includes(r.filePaths[0])) dirs.push(r.filePaths[0]);
          return manager.configure(a.sessionId, { additionalDirectories: dirs });
        }
        case 'start':
          return manager.start(a.sessionId);
        case 'stop':
          return manager.stop(a.sessionId);
        case 'interrupt':
          return manager.interrupt(a.sessionId);
        case 'refreshUsage':
          return manager.refreshUsage(a.profile);
        case 'pickImages': {
          manager.session(a.sessionId);
          const r = await dialog.showOpenDialog(win, {
            title: 'Adjuntar imágenes',
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
          });
          return r.canceled ? [] : attachments.add(a.sessionId, r.filePaths);
        }
        case 'dropImages':
          manager.session(a.sessionId);
          return attachments.addData(a.sessionId, a.images);
        case 'gitOperation':
          return manager.gitOperation(a.projectId, a.operation, a.value);
        case 'discardImages':
          return attachments.discard(a.sessionId, a.attachmentIds);
        case 'send': {
          const images = await attachments.resolve(a.sessionId, a.attachmentIds ?? []);
          attachments.markUsed(a.attachmentIds ?? []);
          return manager.send(a.sessionId, a.text, images);
        }
        case 'approve':
          return manager.approve(a.sessionId, a.requestId, a.decision, a.answers, a.message);
        case 'login': {
          const url = await manager.login(a.sessionId);
          if (url) {
            const parsed = new URL(url);
            if (
              parsed.protocol !== 'https:' ||
              !['auth.openai.com', 'chatgpt.com'].includes(parsed.hostname)
            )
              throw new Error('URL de autenticación no reconocida.');
            await shell.openExternal(url);
          }
          return;
        }
        case 'cancelLogin':
          return manager.cancelLogin(a.sessionId);
        case 'terminalWrite':
          if (a.sessionId.startsWith('shell:'))
            return manager.terminals.processes.get(a.sessionId)?.pty.write(a.data);
          if (a.sessionId.startsWith('account:'))
            return manager.accounts.terminal(a.sessionId)?.write(a.data);
          return manager.runtime(a.sessionId).pty?.write(a.data);
        case 'terminalResize':
          if (a.sessionId.startsWith('shell:'))
            return manager.terminals.processes.get(a.sessionId)?.pty.resize(a.cols, a.rows);
          if (a.sessionId.startsWith('account:'))
            return manager.accounts.terminal(a.sessionId)?.resize(a.cols, a.rows);
          return manager.runtime(a.sessionId).pty?.resize(a.cols, a.rows);
        case 'terminalBuffer':
          if (a.sessionId.startsWith('shell:'))
            return manager.terminals.buffers.get(a.sessionId) ?? { data: '', sequence: 0 };
          if (a.sessionId.startsWith('account:'))
            return manager.accounts.buffers.get(a.sessionId) ?? { data: '', sequence: 0 };
          return manager.buffers.get(a.sessionId) ?? { data: '', sequence: 0 };
        case 'diff':
          return manager.diff(a.projectId);
        case 'chooseBinary': {
          const r = await dialog.showOpenDialog(win, {
            title: `Seleccionar ejecutable de ${a.tool}`,
            properties: ['openFile', 'showHiddenFiles'],
          });
          if (!r.canceled) {
            manager.state.tools[a.tool] = r.filePaths[0];
            manager.changed();
          }
          return;
        }
      }
    } catch (error) {
      throw new Error(network.redact((error as Error).message));
    }
  });
  await createWindow();
  void (async () => {
    for (const p of manager.state.profiles ?? []) {
      if (quitting) break;
      if (manager.accounts.state[p.id] && !manager.accounts.changing(p.id))
        await manager.accounts.refresh(p.id).catch(() => {});
    }
  })();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});
app.on('window-all-closed', () => {
  /* On macOS, closing the window keeps the sessions alive until Quit. */
});
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void (async () => {
    const results = await manager?.shutdown();
    if (results?.some((r) => r.status === 'rejected')) {
      quitting = false;
      restartRequested = false;
      dialog.showErrorBox(
        'Cierre pendiente',
        'No se ha confirmado la salida de todos los procesos. Vuelve a intentar salir.',
      );
      return;
    }
    browser?.closeAll();
    await attachments.cleanup().catch(() => {});
    app.quit();
  })();
});
