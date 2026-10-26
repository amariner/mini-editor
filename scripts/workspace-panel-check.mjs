// Isolated file-review interactions; no personal files, accounts, Git writes or model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundle = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {WorkspacePanel} from './src/workspace-panel';
const files = [
 {path:'src/a.ts',index:' ',worktree:'M',conflict:false},
 {path:'new.ts',index:'?',worktree:'?',conflict:false},
];
const git = () => ({repository:true,branch:'main',branches:['main'],files:structuredClone(files),counts:{staged:files.filter(f=>f.index==='M').length,unstaged:files.filter(f=>f.worktree==='M').length,untracked:1,conflicts:0},status:'M src/a.ts',staged:'',unstaged:'',commits:[]});
window.fixture = {actions:[],hold:false};
function Fixture(){
 const [view,setView]=useState('details');
 const [snapshot,setSnapshot]=useState(git);
 const [project,setProject]=useState({id:'p',name:'Proyecto',path:'/fixture'});
 window.fixture.changeProject=()=>setProject({id:'other',name:'Otro proyecto',path:'/other'});
 const invoke=async(action)=>{
  window.fixture.actions.push(action);
  if(action.type==='workspaceFiles'){
   const entries=action.query ? [{path:'src/a.ts',name:'a.ts',kind:'file'}].filter(e=>e.path.includes(action.query)) : action.directory==='src' ? [{path:'src/a.ts',name:'a.ts',kind:'file'}] : [{path:'src',name:'src',kind:'directory'},{path:'new.ts',name:'new.ts',kind:'file'},{path:'logo.bin',name:'logo.bin',kind:'file'}];
   return {root:project.path,entries,truncated:false};
  }
  if(action.type==='workspaceFile'){
   const result={root:project.path,path:action.path,content:action.path==='src/a.ts'?'const value = 2;\\nexport { value };':'export const fresh = true;'+String.fromCharCode(10)+'// '+ 'long_identifier_'.repeat(50),binary:action.path==='logo.bin',size:42,truncated:false,language:'ts'};
   if(window.fixture.hold){window.fixture.hold=false;return new Promise(resolve=>window.fixture.release=()=>resolve(result));}
   return result;
  }
  if(action.type==='workspaceDiff'){if(window.fixture.delayDiff)await new Promise(resolve=>setTimeout(resolve,180));return {root:project.path,path:action.path,filePath:action.path,patch:'diff --git a/src/a.ts b/src/a.ts\\n--- a/src/a.ts\\n+++ b/src/a.ts\\n@@ -1 +1 @@\\n-const value = 1;\\n+const value = 2;\\n',binary:false,truncated:false};}
  if(action.type==='workspaceStage'){
   const file=files.find(f=>f.path===action.path);file.index=action.staged?'M':' ';file.worktree=action.staged?' ':'M';return true;
  }
  throw Error('Unexpected action '+action.type);
 };
 return <div className="app"><WorkspacePanel project={project} git={snapshot} view={view} onViewChange={setView} onClose={()=>window.fixture.closed=true} onRefresh={()=>setSnapshot(git())} onOpenExternal={path=>window.fixture.external=path} invoke={invoke} details={<p>Detalles de prueba</p>}/></div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`,
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  write: false,
});
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
  const page = await browser.newPage({
    viewport: { width: 920, height: 680 },
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<!doctype html><div id="root"></div>');
  await page.addStyleTag({
    content:
      (
        await Promise.all(
          ['src/style.css', 'src/shell-polish.css', 'src/workspace-panel.css'].map((file) =>
            fs.readFile(file, 'utf8'),
          ),
        )
      ).join('\n') +
      '\n.app {position:fixed;inset:0;display:flex;padding:0}.workspace-panel{height:100%;}',
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const panel = page.getByRole('region', { name: 'Panel de trabajo', exact: true });
  await panel.waitFor();
  await page.getByRole('tab', { name: 'Archivos', exact: true }).click();
  const fileList = page.getByRole('navigation', { name: 'Archivos del proyecto', exact: true });
  await fileList.getByRole('button', { name: 'src', exact: true }).click();
  await fileList.getByRole('button', { name: 'a.ts', exact: true }).click();
  await page.getByRole('region', { name: 'Contenido de src/a.ts', exact: true }).waitFor();
  assert.equal(await panel.locator('.workspace-line-number').first().innerText(), '1');
  assert.match(await panel.locator('.workspace-code').innerText(), /const value = 2/);
  await page.getByRole('button', { name: 'Abrir archivo fuera de la app', exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixture.external), 'src/a.ts');

  await fileList.getByRole('button', { name: 'src', exact: true }).click();
  await page.evaluate(() => (window.fixture.hold = true));
  await fileList.getByRole('button', { name: 'logo.bin', exact: true }).click();
  await page.waitForFunction(() => typeof window.fixture.release === 'function');
  await fileList.getByRole('button', { name: 'new.ts', exact: true }).click();
  await page.getByRole('region', { name: 'Contenido de new.ts', exact: true }).waitFor();
  await page.evaluate(() => window.fixture.release());
  assert.match(await panel.locator('.workspace-code').innerText(), /fresh/);
  assert.equal(await panel.getByText('Archivo binario', { exact: true }).count(), 0);
  await fileList.getByRole('button', { name: 'logo.bin', exact: true }).click();
  await panel.getByText('Archivo binario', { exact: true }).waitFor();

  await page.getByRole('tab', { name: /Cambios/ }).click();
  await page.getByRole('region', { name: 'Cambios de src/a.ts', exact: true }).waitFor();
  assert.equal(await panel.locator('.workspace-diff-added').count(), 1);
  assert.equal(await panel.locator('.workspace-diff-removed').count(), 1);
  await panel.locator('.workspace-code').evaluate((element) => (element.dataset.retained = 'true'));
  await page.evaluate(() => (window.fixture.delayDiff = true));
  await page.getByRole('button', { name: 'Actualizar archivos y cambios', exact: true }).click();
  assert.equal(
    await panel.locator('.workspace-code').getAttribute('data-retained'),
    'true',
    'refresh retains the reading surface and its scroll position',
  );
  await page.evaluate(() => (window.fixture.delayDiff = false));
  await page.getByRole('button', { name: 'Preparar archivo', exact: true }).click();
  await page.waitForFunction(() =>
    window.fixture.actions.some(
      (action) => action.type === 'workspaceStage' && action.path === 'src/a.ts' && action.staged,
    ),
  );
  await page
    .getByRole('combobox', { name: 'Cambios a revisar', exact: true })
    .selectOption('staged');
  await page.getByRole('region', { name: 'Cambios de src/a.ts', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Ver archivo completo', exact: true }).click();
  await page.getByRole('region', { name: 'Contenido de src/a.ts', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('tab', { name: 'Archivos', exact: true }).getAttribute('aria-selected'),
    'true',
  );
  await page.getByRole('tab', { name: /Cambios/ }).click();
  await page.getByRole('button', { name: 'Quitar de preparados', exact: true }).click();
  await page.waitForFunction(() =>
    window.fixture.actions.some(
      (action) => action.type === 'workspaceStage' && action.path === 'src/a.ts' && !action.staged,
    ),
  );
  await page
    .getByRole('combobox', { name: 'Cambios a revisar', exact: true })
    .selectOption('unstaged');
  await page.getByRole('region', { name: 'Cambios de src/a.ts', exact: true }).waitFor();
  await fs.mkdir('artifacts/workspace-panel', { recursive: true });
  await page.screenshot({ path: 'artifacts/workspace-panel/changes-dark.png' });
  await page.setViewportSize({ width: 360, height: 600 });
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
  const bounds = await panel.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 360);
  await page.screenshot({ path: 'artifacts/workspace-panel/changes-compact.png' });

  await page.getByRole('tab', { name: 'Archivos', exact: true }).click();
  await fileList.getByRole('button', { name: 'new.ts', exact: true }).click();
  const fileContent = page.getByRole('region', { name: 'Contenido de new.ts', exact: true });
  await fileContent.waitFor();
  assert.ok(
    await fileContent.evaluate((element) => element.scrollWidth > element.clientWidth),
    'long source lines scroll inside the viewer',
  );
  await fileContent.evaluate((element) => (element.scrollLeft = 100));
  assert.ok(await fileContent.evaluate((element) => element.scrollLeft > 0));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await fileContent.evaluate((element) => (element.scrollLeft = 0));
  await page.setViewportSize({ width: 920, height: 680 });
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    const contrast = await fileContent.evaluate((element) => {
      const context = document.createElement('canvas').getContext('2d');
      const luminance = (color) => {
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const values = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((v) => {
          const x = v / 255;
          return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        });
        return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
      };
      const style = getComputedStyle(element);
      const fg = luminance(style.color),
        bg = luminance(style.backgroundColor);
      return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    });
    assert.ok(contrast >= 4.5, `${colorScheme} code contrast ${contrast}`);
    await page.screenshot({ path: `artifacts/workspace-panel/files-${colorScheme}.png` });
  }
  await page.evaluate(() => window.fixture.changeProject());
  await panel.getByText('Explora tu proyecto', { exact: true }).waitFor();
  assert.equal(
    await panel.locator('.workspace-code').count(),
    0,
    'old project content disappears immediately',
  );
  await page.getByRole('button', { name: 'Cerrar panel de trabajo', exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixture.closed), true);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: directory browsing, file content, stale read isolation, binary state, per-file diff/stage/unstage, retained reader on refresh, compact layout, long lines, light/dark contrast and project switch.',
  );
} finally {
  await browser?.close();
}
