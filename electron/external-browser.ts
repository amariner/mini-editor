import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shell } from 'electron';
import { browserURL } from '../src/browser-protocol';

export async function openInChrome(url: string) {
  const safe = browserURL(url);
  if (process.platform === 'darwin') {
    try {
      await promisify(execFile)('/usr/bin/open', ['-a', 'Google Chrome', safe]);
      return;
    } catch {
      // Chrome may not be installed; use the user's default browser.
    }
  }
  await shell.openExternal(safe);
}
