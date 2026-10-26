// Renders build/icon.svg into build/icon.png and the macOS build/icon.icns.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'darwin') throw new Error('iconutil solo está disponible en macOS.');
const svg = await fs.readFile('build/icon.svg', 'utf8');
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-icon-'));
const iconset = path.join(work, 'icon.iconset');
await fs.mkdir(iconset);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const render = async (size, file) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    await page.screenshot({ path: file, omitBackground: true });
  };
  for (const size of [16, 32, 128, 256, 512]) {
    await render(size, path.join(iconset, `icon_${size}x${size}.png`));
    await render(size * 2, path.join(iconset, `icon_${size}x${size}@2x.png`));
  }
  await render(1024, 'build/icon.png');
} finally {
  await browser.close();
}
execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', 'build/icon.icns']);
await fs.rm(work, { recursive: true, force: true });
console.log('Icono generado: build/icon.png y build/icon.icns');
