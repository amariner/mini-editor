import { chmodSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as nativePty from 'node-pty';

export type { IPty } from 'node-pty';

/** npm's macOS prebuild can ship spawn-helper as 0644. It must be executable. */
export function preparePtyHelpers(root: string, platform = process.platform, arch = process.arch) {
  if (platform !== 'darwin') return;
  for (const directory of ['build/Release', 'build/Debug', `prebuilds/${platform}-${arch}`]) {
    const helper = path
      .join(root, directory, 'spawn-helper')
      .replace('app.asar', 'app.asar.unpacked')
      .replace('node_modules.asar', 'node_modules.asar.unpacked');
    let mode: number;
    try {
      mode = statSync(helper).mode;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (mode & 0o100) continue;
    try {
      // Restore only the owner's execute permission; preserve all other permissions.
      chmodSync(helper, mode | 0o100);
    } catch {
      throw new Error(
        `No se puede habilitar el auxiliar de terminal: ${helper}. Revisa sus permisos y vuelve a intentarlo.`,
      );
    }
  }
}

export const spawn: typeof nativePty.spawn = (file, args, options) => {
  if (process.platform === 'darwin') {
    const from =
      typeof __filename === 'string' ? __filename : path.join(process.cwd(), 'package.json');
    const root = path.dirname(createRequire(from).resolve('node-pty/package.json'));
    preparePtyHelpers(root);
  }
  return nativePty.spawn(file, args, options);
};
