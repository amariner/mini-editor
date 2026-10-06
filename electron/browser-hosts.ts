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
