import fs from 'node:fs';
import path from 'node:path';
import type { Theme } from '../src/shared';
/** Interface theme chosen in Settings, kept beside state.json so the window opens in it. */
const file = (dir: string) => path.join(dir, 'appearance.json');
export function readTheme(dir: string): Theme {
  try {
    const theme = JSON.parse(fs.readFileSync(file(dir), 'utf8'))?.theme;
    return theme === 'light' || theme === 'dark' ? theme : 'system';
  } catch {
    return 'system';
  }
}
export function writeTheme(dir: string, theme: Theme) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file(dir) + '.tmp', JSON.stringify({ theme }), { mode: 0o600 });
  fs.renameSync(file(dir) + '.tmp', file(dir));
}
