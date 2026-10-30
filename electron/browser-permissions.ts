import { randomUUID } from 'node:crypto';
import type { BrowserPermission } from '../src/browser-permissions';

const routine = new Set([
  'fullscreen',
  'clipboard-sanitized-write',
  'persistent-storage',
  'screen-wake-lock',
]);
const labels: Record<string, string> = {
  'clipboard-read': 'Leer el portapapeles',
  'deprecated-sync-clipboard-read': 'Leer el portapapeles',
  notifications: 'Mostrar notificaciones',
  geolocation: 'Usar tu ubicación',
  'geolocation-approximate': 'Usar tu ubicación aproximada',
  media: 'Usar cámara o micrófono',
  fileSystem: 'Acceder a los archivos seleccionados',
  'local-fonts': 'Usar fuentes locales',
  pointerLock: 'Capturar el puntero en esta página',
  keyboardLock: 'Capturar el teclado en esta página',
};
type Pending = {
  value: BrowserPermission;
  wc: Electron.WebContents;
  resolve: (allow: boolean) => void;
};

function webOrigin(value: string) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

// The requesting frame can disappear before Electron receives its decision.
function decide(callback: (allow: boolean) => void, allow: boolean) {
  try {
    callback(allow);
  } catch {
    /* A closed Chromium frame cannot receive a response. */
  }
}

/** Device/data access is decided in trusted app chrome, never by page content or agent tools. */
export class BrowserPermissions {
  private pending = new Map<string, Pending>();
  private closed = false;
  constructor(
    private owns: (wc: Electron.WebContents) => boolean,
    private changed: () => void,
  ) {}
  list(wc?: Electron.WebContents) {
    return wc
      ? [...this.pending.values()].filter((p) => p.wc === wc).map((p) => ({ ...p.value }))
      : [];
  }
  install(session: Electron.Session) {
    session.setPermissionCheckHandler(
      (wc, permission, origin) =>
        !this.closed &&
        !!wc &&
        !wc.isDestroyed() &&
        this.owns(wc) &&
        !!webOrigin(origin) &&
        routine.has(permission),
    );
    session.setPermissionRequestHandler((wc, permission, callback, details) => {
      if (this.closed || !this.owns(wc) || wc.isDestroyed()) return decide(callback, false);
      const media = details as Electron.MediaAccessPermissionRequest;
      // Media requests provide the actual security origin even for inherited about:blank
      // frames. Never present the top page as the requester of an unidentified subframe.
      const origin = webOrigin(
        media.securityOrigin || details.requestingUrl || (details.isMainFrame ? wc.getURL() : ''),
      );
      if (!origin) return decide(callback, false);
      if (routine.has(permission)) return decide(callback, true);
      // Unsupported device pickers (screen/USB/serial) cannot be granted by a boolean alone.
      if (!labels[permission] || this.list(wc).length >= 5) return decide(callback, false);
      const id = randomUUID();
      const fs = details as Electron.FilesystemPermissionRequest;
      const value: BrowserPermission = {
        id,
        origin,
        permission,
        label: labels[permission],
        ...(permission === 'fileSystem'
          ? {
              detail: `${fs.fileAccessType === 'writable' ? 'Escritura' : 'Lectura'}: ${fs.filePath ?? 'archivo seleccionado'}`,
            }
          : {}),
        ...(permission === 'media' && media.mediaTypes?.length
          ? { detail: media.mediaTypes.join(', ') }
          : {}),
      };
      const cancel = () => finish(false);
      const navigation = (_e: unknown, _url: string, _inPlace: boolean, main: boolean) => {
        if (main || !details.isMainFrame) cancel();
      };
      const finish = (allow: boolean) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        wc.removeListener('destroyed', cancel);
        wc.removeListener('did-start-navigation', navigation);
        decide(callback, allow && !this.closed && !wc.isDestroyed() && this.owns(wc));
        if (!this.closed) this.changed();
      };
      const timer = setTimeout(cancel, 90000);
      timer.unref();
      this.pending.set(id, { value, wc, resolve: finish });
      wc.once('destroyed', cancel);
      wc.on('did-start-navigation', navigation);
      this.changed();
    });
  }
  respond(wc: Electron.WebContents, id: string, allow: boolean) {
    const pending = this.pending.get(id);
    if (!pending || pending.wc !== wc)
      throw new Error('La solicitud de permiso ya no está activa.');
    pending.resolve(allow);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of [...this.pending.values()]) pending.resolve(false);
    this.changed();
  }
}
