import { net } from 'electron';
import type { ProxySettings } from './proxy';

export const proxyAuthError =
  'El proxy requiere autenticación (407). Revisa el usuario y la contraseña en Ajustes → Red y vuelve a conectar el proveedor.';

export function providerNetworkError(error: Error) {
  if (/ERR_(PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED)/.test(error.message))
    return new Error('No se pudo conectar con el proxy. Revisa Ajustes → Red y tu conexión o VPN.');
  if (/ERR_(PROXY_AUTH|INVALID_AUTH_CREDENTIALS)/.test(error.message))
    return new Error(proxyAuthError);
  if (/ERR_CERT_|ERR_SSL_/.test(error.message))
    return new Error(
      'No se pudo validar la conexión segura del proveedor. Comprueba el certificado de tu red en macOS y los ajustes de red.',
    );
  if (
    /ERR_(NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|NETWORK_CHANGED|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_REFUSED|TIMED_OUT)/.test(
      error.message,
    )
  )
    return new Error(
      'Se perdió la conexión con el proveedor. Comprueba la red e inténtalo de nuevo.',
    );
  return error;
}

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
  const method = (init.method ?? 'GET').toUpperCase();
  return new Promise((resolve, reject) => {
    const request = net.request({
      url,
      session,
      method,
      redirect: 'error',
      useSessionCookies: false,
      headers: Object.fromEntries(new Headers(init.headers)),
    });
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let finished = false;
    let authAttempts = 0;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timeout);
      init.signal?.removeEventListener('abort', abort);
    };
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      controller?.error(error);
      reject(error);
      request.abort();
    };
    const touch = () => {
      clearTimeout(timeout);
      timeout = setTimeout(
        () =>
          fail(
            new Error(
              'El proveedor lleva 90 segundos sin responder. Comprueba la conexión y vuelve a intentarlo.',
            ),
          ),
        90_000,
      );
      timeout.unref();
    };
    const abort = () => {
      fail(init.signal?.reason ?? new DOMException('Petición cancelada', 'AbortError'));
    };
    request.on('login', (auth, callback) => {
      // Proxy credentials must never answer an origin server's authentication challenge.
      if (!auth.isProxy) return callback();
      try {
        const credentials = network.credentials(auth.host, auth.port);
        if (credentials && ++authAttempts <= 2) {
          touch();
          return callback(credentials.username, credentials.password);
        }
        callback();
        return fail(new Error(proxyAuthError));
      } catch (error) {
        callback();
        fail(error as Error);
      }
    });
    request.on('error', (error) => fail(providerNetworkError(error)));
    request.on('response', (response) => {
      if (finished) return;
      if (response.statusCode === 407) return fail(new Error(proxyAuthError));
      touch();
      const headers = new Headers();
      for (const [name, values] of Object.entries(response.headers))
        for (const value of Array.isArray(values) ? values : [values]) headers.append(name, value);
      const source = response as Electron.IncomingMessage & import('node:stream').Readable;
      const body = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
          response.on('data', (chunk) => {
            if (finished) return;
            value.enqueue(new Uint8Array(chunk));
            touch();
            if ((value.desiredSize ?? 0) <= 0) {
              source.pause();
              clearTimeout(timeout);
            }
          });
          response.on('end', () => {
            if (finished) return;
            finished = true;
            cleanup();
            value.close();
          });
          response.on('error', (error) => fail(providerNetworkError(error)));
          response.on('aborted', () => fail(new Error('El proveedor interrumpió la respuesta.')));
        },
        pull() {
          if (finished) return;
          touch();
          source.resume();
        },
        cancel() {
          finished = true;
          cleanup();
          request.abort();
        },
      });
      const noBody = method === 'HEAD' || [204, 205, 304].includes(response.statusCode);
      resolve(new Response(noBody ? null : body, { status: response.statusCode, headers }));
      if (noBody) void body.cancel();
    });
    init.signal?.addEventListener('abort', abort, { once: true });
    if (init.signal?.aborted) return abort();
    touch();
    request.end(requestBody);
  });
}
