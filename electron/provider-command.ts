import { spawn } from 'node:child_process';
import { cleanEnv } from './core';
import { reapGroup } from './processes';
/** A approved command owns a process group; cancellation reaps its children before returning. */
export function providerCommand(
  command: string,
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd,
      env: cleanEnv(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '',
      failure: Error | undefined,
      cleanup: Promise<void> | undefined;
    const stop = () => {
      if (!child.pid) return;
      cleanup ??= reapGroup(child.pid);
      void cleanup.catch(() => {});
    };
    const abort = () => {
      failure = new Error('Comando interrumpido.');
      stop();
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => {
      failure = new Error('El comando superó 60 segundos.');
      stop();
    }, 60000);
    const collect = (data: Buffer) => {
      if (output.length < 40000) output += data.toString().slice(0, 40000 - output.length);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (e) => {
      failure = e;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      void (async () => {
        // Also reap background descendants of a shell which exits before its children.
        if (child.pid) await (cleanup ?? reapGroup(child.pid));
        if (failure) throw failure;
        if (code !== 0) throw new Error(`El comando terminó con código ${code}.\n${output}`);
        resolve(output);
      })().catch(reject);
    });
  });
}
