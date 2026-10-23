import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

export class McpNeedsAuth extends Error {
  constructor() {
    super('Inicia sesión para utilizar esta conexión.');
  }
}
export interface McpOAuthState {
  redirectUrl?: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  expiresAt?: number;
  discovery?: OAuthDiscoveryState;
}

/** PKCE is handled by the SDK; the verifier is kept only for this authorization attempt. */
export function oauthProvider(
  state: McpOAuthState,
  save: () => void,
  interactive?: { state: string; open: (url: string) => Promise<void> },
): OAuthClientProvider {
  let verifier: string | undefined;
  return {
    get redirectUrl() {
      return state.redirectUrl;
    },
    get clientMetadata() {
      return {
        client_name: 'Agent Desk',
        redirect_uris: state.redirectUrl ? [state.redirectUrl] : [],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };
    },
    state: () => interactive?.state ?? randomBytes(32).toString('hex'),
    clientInformation: () => state.client,
    saveClientInformation: (client) => {
      state.client = client;
    },
    tokens: () => state.tokens,
    saveTokens: (tokens) => {
      state.tokens = {
        ...tokens,
        refresh_token: tokens.refresh_token ?? state.tokens?.refresh_token,
      };
      state.expiresAt =
        tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000;
      save();
    },
    redirectToAuthorization: async (url) => {
      if (!interactive) throw new McpNeedsAuth();
      validateMcpUrl(url);
      await interactive.open(url.href);
    },
    saveCodeVerifier: (value) => {
      verifier = value;
    },
    codeVerifier: () => {
      if (!verifier) throw new McpNeedsAuth();
      return verifier;
    },
    discoveryState: () => state.discovery,
    saveDiscoveryState: (discovery) => {
      state.discovery = discovery;
    },
    invalidateCredentials: (scope) => {
      if (scope === 'all' || scope === 'client') delete state.client;
      if (scope === 'all' || scope === 'tokens') {
        delete state.tokens;
        delete state.expiresAt;
      }
      if (scope === 'all' || scope === 'discovery') delete state.discovery;
      if (scope === 'all' || scope === 'verifier') verifier = undefined;
    },
  };
}

/** No userinfo or cleartext credentials are ever sent to a non-loopback HTTP endpoint. */
export function validateMcpUrl(url: URL) {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error(
      'Usa una URL HTTPS sin credenciales ni fragmento; HTTP solo se admite en localhost.',
    );
}

export async function oauthCallback(signal: AbortSignal) {
  const state = randomBytes(32).toString('hex');
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Cancellation can happen before the caller starts awaiting the callback.
  void code.catch(() => {});
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const received = Buffer.from(url.searchParams.get('state') ?? '');
    const expected = Buffer.from(state);
    const valid =
      request.method === 'GET' &&
      url.pathname === '/oauth/callback' &&
      received.length === expected.length &&
      timingSafeEqual(received, expected);
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'");
    if (!valid) {
      response.writeHead(400).end('Solicitud de autenticación no válida.');
      return;
    }
    const value = url.searchParams.get('code');
    if (url.searchParams.has('error') || !value || value.length > 8192) {
      response.writeHead(400).end('Autenticación cancelada. Puedes volver a Agent Desk.');
      rejectCode(new McpNeedsAuth());
      return;
    }
    response.end('Autenticación recibida. Puedes volver a Agent Desk.');
    resolveCode(value);
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const abort = () => {
    rejectCode(new DOMException('Cancelled', 'AbortError'));
    server.close();
    server.closeAllConnections();
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No se pudo abrir la respuesta de autenticación.');
  return {
    state,
    redirectUrl: `http://127.0.0.1:${address.port}/oauth/callback`,
    code,
    close: async () => {
      signal.removeEventListener('abort', abort);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
