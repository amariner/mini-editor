import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { context } from 'esbuild';
import electron from 'electron';
import { buildOptions } from './build-options.mjs';

let child, server, builder;
let stopping = false;
let restart = false;
let built = false;
async function cleanup(code = 0) {
  await builder?.dispose();
  await server?.close();
  process.exitCode = code;
}
function launch() {
  restart = false;
  child = spawn(electron, ['.'], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, AGENT_DESK_DEV_URL: 'http://127.0.0.1:5173' },
  });
  child.on('message', (message) => {
    if (message === 'desk:dev-restart') restart = true;
  });
  child.on('error', async (error) => {
    console.error(error.message);
    await cleanup(1);
  });
  child.on('exit', async (code) => {
    if (restart && !stopping) launch();
    else await cleanup(code ?? 0);
  });
}
try {
  // Bind first: never overwrite the running build when a dev server already owns the port.
  server = await createServer();
  await server.listen();
  let initialResult;
  const initialBuild = new Promise((resolve) => {
    initialResult = resolve;
  });
  builder = await context({
    ...buildOptions,
    plugins: [
      {
        name: 'main-process-update',
        setup(build) {
          build.onEnd((result) => {
            if (!built) initialResult(result);
            if (result.errors.length) return;
            if (built && child?.connected) {
              child.send('desk:dev-update');
              console.log(
                'Actualización preparada. Detén las sesiones y pulsa «Actualizar aplicación» en Agent Desk.',
              );
            }
            built = true;
          });
        },
      },
    ],
  });
  await builder.watch();
  const initial = await initialBuild;
  if (initial.errors.length) throw new Error('No se ha podido compilar el proceso principal.');
  launch();
} catch (error) {
  console.error(error.message);
  await cleanup(1);
}
function stop() {
  stopping = true;
  // Electron confirms process shutdown before exiting. No SIGKILL of live agents.
  if (child?.connected) child.send('desk:dev-quit');
  else if (!child) void cleanup();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
