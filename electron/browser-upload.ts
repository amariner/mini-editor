import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const privatePart =
  /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.azure|\.gnupg|\.codex|\.claude|\.npmrc|\.netrc|\.pypirc|credentials(?:\.json)?|api-key\.enc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/i;
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return (
    relative !== '' &&
    !path.isAbsolute(relative) &&
    relative !== '..' &&
    !relative.startsWith('..' + path.sep)
  );
};

/** Native chooser selections are explicit user grants; tool paths stay within this project. */
export async function browserUploadPaths(
  paths: string[],
  root?: string,
  options: { userSelected?: boolean } = {},
) {
  if (paths.length > 20 || paths.some((file) => !file || file.length > 4096 || file.includes('\0')))
    throw new Error('Selecciona hasta 20 archivos válidos.');
  if (!options.userSelected && !root)
    throw new Error('La subida del agente necesita una pestaña asociada a un proyecto.');
  const directory = root ? await fs.realpath(root) : undefined;
  const result: { path: string; name: string; size: number }[] = [];
  for (const input of paths) {
    const requested = path.resolve(directory ?? '/', input);
    const resolved = await fs.realpath(requested).catch(() => {
      throw new Error(`No se encuentra el archivo ${path.basename(input)}.`);
    });
    if (!options.userSelected) {
      if (!inside(directory!, requested) || !inside(directory!, resolved))
        throw new Error(
          'El archivo está fuera del proyecto. Selecciónalo mediante el diálogo de archivos del navegador.',
        );
      if (
        [path.relative(directory!, requested), path.relative(directory!, resolved)].some(
          (relative) => relative.split(path.sep).some((part) => privatePart.test(part)),
        ) ||
        /\.(?:pem|key|p12|pfx)$/i.test(resolved)
      )
        throw new Error('Los archivos de credenciales requieren selección manual en el navegador.');
    }
    const info = await fs.stat(resolved);
    if (!info.isFile()) throw new Error('Selecciona archivos individuales, no carpetas.');
    result.push({ path: resolved, name: path.basename(resolved), size: info.size });
  }
  return result;
}

export async function uploadBrowserFiles(
  wc: Electron.WebContents,
  ref: string,
  paths: string[],
  root?: string,
  options: { userSelected?: boolean } = {},
) {
  if (!/^e\d+$/.test(ref))
    throw new Error('Referencia de archivo inválida. Vuelve a inspeccionar.');
  const files = await browserUploadPaths(paths, root, options);
  if (wc.isDestroyed()) throw new Error('La pestaña ya no existe.');
  // A short-lived random DOM marker resolves the exact inspected node through CDP,
  // including open shadow roots and same-origin frames, without exposing file paths to JS.
  const marker = 'data-agent-desk-upload-' + randomUUID().replaceAll('-', '');
  const inspect = `(()=>{const e=window.__deskAutomation?.elements.get(${JSON.stringify(ref)});if(!e?.isConnected)return {error:'Referencia caducada. Vuelve a inspeccionar.'};if(e.tagName!=='INPUT'||e.type!=='file')return {error:'Selecciona un campo de archivo de inspect.'};if(e.disabled)return {error:'El campo de archivo está deshabilitado.'};if(e.webkitdirectory)return {error:'Este campo requiere una carpeta; selecciónala manualmente.'};if(!e.multiple&&${files.length}>1)return {error:'Este campo admite un solo archivo.'};e.setAttribute(${JSON.stringify(marker)},'');return {ok:true};})()`;
  const result = await wc.executeJavaScriptInIsolatedWorld(1001, [{ code: inspect }], true);
  if (result.error) throw new Error(result.error);
  const attached = wc.debugger.isAttached();
  let searchId: string | undefined;
  try {
    if (!attached) wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('DOM.getDocument', { depth: 0, pierce: true });
    const search = await wc.debugger.sendCommand('DOM.performSearch', {
      query: `[${marker}]`,
      includeUserAgentShadowDOM: true,
    });
    searchId = search.searchId;
    if (search.resultCount !== 1)
      throw new Error('El campo de archivo cambió. Vuelve a inspeccionar.');
    const nodes = await wc.debugger.sendCommand('DOM.getSearchResults', {
      searchId,
      fromIndex: 0,
      toIndex: 1,
    });
    await wc.debugger.sendCommand('DOM.setFileInputFiles', {
      nodeId: nodes.nodeIds[0],
      files: files.map((file) => file.path),
    });
    return { ok: true, files: files.map(({ name, size }) => ({ name, size })) };
  } finally {
    if (!wc.isDestroyed()) {
      if (searchId && wc.debugger.isAttached())
        await wc.debugger.sendCommand('DOM.discardSearchResults', { searchId }).catch(() => {});
      if (!attached && wc.debugger.isAttached()) wc.debugger.detach();
      await wc
        .executeJavaScriptInIsolatedWorld(1001, [
          {
            code: `window.__deskAutomation?.elements.get(${JSON.stringify(ref)})?.removeAttribute(${JSON.stringify(marker)})`,
          },
        ])
        .catch(() => {});
    }
  }
}
