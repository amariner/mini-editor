import net from 'node:net';
export function localEndpoint(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host)
    )
      return;
    return {
      host: host === '0.0.0.0' ? '127.0.0.1' : host,
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    };
  } catch {
    return;
  }
}
export function localURLs(output: string) {
  const clean = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  return [
    ...new Set(
      (
        clean.match(
          /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{1,5}(?:\/[^\s<>"'`]*)?/g,
        ) ?? []
      ).flatMap((value) => {
        try {
          const url = new URL(value);
          if (!localEndpoint(value)) return [];
          if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
          return [url.origin + '/'];
        } catch {
          return [];
        }
      }),
    ),
  ];
}
export async function hostOnline(url: string): Promise<boolean | undefined> {
  const endpoint = localEndpoint(url);
  if (!endpoint) return;
  const connect = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host, port: endpoint.port });
      const done = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(700, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
  if (endpoint.host === 'localhost')
    return (await Promise.all([connect('127.0.0.1'), connect('::1')])).some(Boolean);
  return connect(endpoint.host);
}

/** Ports discovered in a chat's tool output, independent of open browser tabs. */
export class DevServerRegistry {
  private entries = new Map<
    string,
    { projectId: string; sessionId: string; url: string; port: number; online: boolean }
  >();
  constructor(private probe = hostOnline) {}
  async observe(projectId: string, sessionId: string, output: string) {
    const added: string[] = [];
    for (const url of localURLs(output)) {
      const port = localEndpoint(url)!.port;
      const key = `${sessionId}:${port}`;
      if (this.entries.has(key)) continue;
      if (this.entries.size >= 256) this.entries.delete(this.entries.keys().next().value!);
      this.entries.set(key, { projectId, sessionId, url, port, online: false });
      added.push(key);
    }
    return this.refresh(added);
  }
  async refresh(keys = [...this.entries.keys()]) {
    let changed = false;
    await Promise.all(
      keys.map(async (key) => {
        const entry = this.entries.get(key);
        if (!entry) return;
        const online = !!(await this.probe(entry.url));
        if (this.entries.get(key) !== entry) return;
        if (entry.online !== online) {
          entry.online = online;
          changed = true;
        }
      }),
    );
    return changed;
  }
  snapshot() {
    return [...this.entries.values()].filter((e) => e.online).map(({ online, ...e }) => e);
  }
  removeProject(projectId: string) {
    for (const [key, e] of this.entries) if (e.projectId === projectId) this.entries.delete(key);
  }
  clear() {
    this.entries.clear();
  }
}
