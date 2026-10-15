import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shell } from 'electron';
import { browserURL } from '../src/browser-protocol';

export async function openInChrome(url: string, requireChrome = false) {
  const safe = browserURL(url);
  if (process.platform === 'darwin') {
    try {
      await promisify(execFile)('/usr/bin/open', ['-a', 'Google Chrome', safe]);
      return;
    } catch {
      if (requireChrome)
        throw new Error('No se pudo abrir Google Chrome. Comprueba que esté instalado.');
      // Chrome may not be installed; use the user's default browser.
    }
  }
  if (requireChrome)
    throw new Error('La apertura directa en Chrome solo está disponible en macOS.');
  await shell.openExternal(safe);
}
