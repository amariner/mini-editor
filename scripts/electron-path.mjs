// Path to the project's Electron binary. Under ELECTRON_RUN_AS_NODE (for example the `node`
// bundled with Agent Desk) `import 'electron'` resolves to Electron's built-in module instead
// of the npm package, so the package is loaded through require.
import { createRequire } from 'node:module';
import electronImport from 'electron';

const electron =
  typeof electronImport === 'string'
    ? electronImport
    : createRequire(import.meta.url)('../node_modules/electron/index.js');
export default electron;
