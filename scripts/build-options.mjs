export const buildOptions = {
  entryPoints: ['electron/main.ts', 'electron/preload.ts', 'electron/coordination-bridge.ts'],
  outdir: 'dist-electron',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
  // The Agent SDK stays external: ESM loaded with a real dynamic import.
  external: ['electron', 'node-pty', '@anthropic-ai/claude-agent-sdk'],
  sourcemap: true,
};
