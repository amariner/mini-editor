import { net } from 'electron';
import type { ProxySettings } from './proxy';

export const proxyAuthError =
  'El proxy requiere autenticación (407). Revisa el usuario y la contraseña en Ajustes → Red y vuelve a conectar OpenRouter.';

/** Provider HTTP transport: Chromium routing, explicit proxy auth, no browser cookies. */
export async function providerFetch(
  session: Electron.Session,
  network: Pick<ProxySettings, 'credentials'>,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  init.signal?.throwIfAborted();
  if (init.body != null && typeof init.body !== 'string')
    throw new Error('El proveedor requiere un cuerpo JSON.');
  const requestBody = init.body ?? undefined;
  return new Promise((resolve, reject) => {
    const request = net.request({
      url,
      session,
      method: init.method ?? 'GET',
      redirect: 'error',
      useSessionCookies: false,
      headers: Object.fromEntries(new Headers(init.headers)),
    });
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let finished = false;
    let authAttempts = 0;
    const cleanup = () => init.signal?.removeEventListener('abort', abort);
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      controller?.error(error);
      reject(error);
    };
    const abort = () => {
      fail(init.signal?.reason ?? new DOMException('Petición cancelada', 'AbortError'));
      request.abort();
    };
    request.on('login', (auth, callback) => {
      // Proxy credentials must never answer an origin server's authentication challenge.
      if (!auth.isProxy) return callback();
      try {
        const credentials = network.credentials(auth.host, auth.port);
        if (credentials && ++authAttempts <= 2)
          return callback(credentials.username, credentials.password);
        fail(new Error(proxyAuthError));
      } catch (error) {
        fail(error as Error);
      }
      callback();
      request.abort();
    });
    request.on('error', fail);
    request.on('response', (response) => {
      const headers = new Headers();
      for (const [name, values] of Object.entries(response.headers))
        for (const value of Array.isArray(values) ? values : [values]) headers.append(name, value);
      const body = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
          response.on('data', (chunk) => {
            if (finished) return;
            value.enqueue(new Uint8Array(chunk));
          });
          response.on('end', () => {
            if (finished) return;
            finished = true;
            cleanup();
            value.close();
          });
          response.on('error', fail);
          response.on('aborted', () => fail(new Error('El proveedor interrumpió la respuesta.')));
        },
        cancel() {
          finished = true;
          cleanup();
          request.abort();
        },
      });
      const noBody = init.method === 'HEAD' || [204, 205, 304].includes(response.statusCode);
      resolve(new Response(noBody ? null : body, { status: response.statusCode, headers }));
      if (noBody) void body.cancel();
    });
    init.signal?.addEventListener('abort', abort, { once: true });
    if (init.signal?.aborted) return abort();
    request.end(requestBody);
  });
}
