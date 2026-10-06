import { Attachments } from './attachments';
import { nativeImage } from 'electron';
import { DeskBrowser } from './browser';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Manager } from './manager';
import { actionSchema } from './core';
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
let updateAvailable = false;
let restartRequested = false;
const snapshot = () => ({
  ...manager.state,
  browsers: browser?.snapshot() ?? [],
  accounts: manager.accounts.state,
  coordination: manager.coordinator.snapshot(),
  terminals: manager.terminals.snapshot(),
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
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161616' : '#e9e8e4',
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
app.whenReady().then(async () => {
  try {
    manager = new Manager(
      app.getPath('userData'),
      (e) => {
        if (win && !win.isDestroyed())
          win.webContents.send('desk:event', e.type === 'state' ? { ...e, state: snapshot() } : e);
      },
      process.env.AGENT_DESK_PROFILES_DIR
        ? path.resolve(process.env.AGENT_DESK_PROFILES_DIR)
        : undefined,
    );
    browser = new DeskBrowser(
      () => win,
      () => manager.changed(),
      (sessionId) => {
        if (win && !win.isDestroyed())
          win.webContents.send('desk:event', { type: 'browserOpened', sessionId });
      },
    );
    manager.coordinator.browserHandler = (session, input) => {
      if (quitting) return Promise.reject(new Error('Agent Desk se está cerrando.'));
      return browser.action(session.id, input);
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
        submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'togglefullscreen' }],
      },
    ]),
  );
  ipcMain.handle('desk:action', async (event, input) => {
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
      case 'addAccount':
        return manager.addAccount(a.kind, a.name);
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
      case 'browser':
        manager.session(a.sessionId);
        return browser.action(a.sessionId, a.input);
      case 'browserPresent':
        if (manager.state.selectedSession === a.sessionId)
          browser.present(a.sessionId, a.bounds, a.visible);
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
        const ids = manager.state.sessions
          .filter((s) => s.projectId === a.projectId)
          .map((s) => s.id);
        await manager.removeProject(a.projectId);
        ids.forEach((id) => browser.close(id));
        return;
      }
      case 'select': {
        const previous = manager.state.selectedSession;
        const selected = manager.select(a.projectId, a.sessionId, a.profile);
        if (selected.id !== previous) browser.hide();
        return selected;
      }
      case 'newSession':
        browser.hide();
        return manager.newSession(a.projectId, a.profile, a.mode);
      case 'configure':
        return manager.configure(a.sessionId, a.config);
      case 'refreshCodexModels':
        return manager.refreshCodexModels(a.sessionId);
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
  });
  await createWindow();
  void (async () => {
    for (const p of manager.state.profiles ?? []) {
      if (quitting) break;
      if (!manager.accounts.changing(p.id)) await manager.accounts.refresh(p.id).catch(() => {});
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
    browser?.closeAll();
    if (results?.some((r) => r.status === 'rejected')) {
      quitting = false;
      restartRequested = false;
      dialog.showErrorBox(
        'Cierre pendiente',
        'No se ha confirmado la salida de todos los procesos. Vuelve a intentar salir.',
      );
      return;
    }
    await attachments.cleanup().catch(() => {});
    app.quit();
  })();
});
