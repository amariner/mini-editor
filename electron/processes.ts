/** Child agents own a process group. Do not release a project while a descendant remains. */
export function groupExists(pid: number) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw e;
  }
}
export async function reapGroup(pid: number) {
  const signal = (s: NodeJS.Signals) => {
    try {
      process.kill(-pid, s);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
    }
  };
  if (!groupExists(pid)) return;
  signal('SIGTERM');
  const start = Date.now();
  while (groupExists(pid)) {
    if (Date.now() - start > 1000) signal('SIGKILL');
    if (Date.now() - start > 6000)
      throw new Error(
        'Hay procesos secundarios cuya salida aún no se ha confirmado. La carpeta sigue bloqueada.',
      );
    await new Promise((r) => setTimeout(r, 50));
  }
}
