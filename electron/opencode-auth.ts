import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

// Device flow used by the official OpenCode client:
// https://github.com/anomalyco/opencode/blob/dev/packages/core/src/plugin/provider/opencode.ts
export const consoleURL = 'https://opencode.ai/console';
const clientID = 'opencode-cli';
export const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive().finite(),
  org_id: z.string().nullable().optional(),
});
export const oauthSchema = z.object({
  kind: z.literal('opencode-oauth'),
  access: z.string().min(1),
  refresh: z.string().min(1),
  expires: z.number().finite(),
  orgID: z.string().optional(),
  email: z.string().optional(),
  orgName: z.string().optional(),
});
export type OpenCodeCredential = z.infer<typeof oauthSchema>;
export type ConsoleJSON = (
  route: string,
  body?: object,
  signal?: AbortSignal,
  token?: string,
  orgID?: string,
) => Promise<any>;
const deviceSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri_complete: z.string(),
  expires_in: z.number().positive().max(3600),
  interval: z.number().positive().max(60),
});
export async function beginDevice(json: ConsoleJSON, signal?: AbortSignal) {
  const device = deviceSchema.parse(
    await json('/auth/device/code', { client_id: clientID, supports_org_scope: true }, signal),
  );
  const url = new URL(device.verification_uri_complete, consoleURL + '/');
  if (
    url.protocol !== 'https:' ||
    !['opencode.ai', 'console.opencode.ai'].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  )
    throw new Error('OpenCode devolvió una dirección de acceso no válida.');
  return { ...device, url: url.href, expiresAt: Date.now() + device.expires_in * 1000 };
}
export type DeviceAttempt = Awaited<ReturnType<typeof beginDevice>>;
export async function pollDevice(
  json: ConsoleJSON,
  device: DeviceAttempt,
  signal: AbortSignal,
): Promise<OpenCodeCredential> {
  let interval = Math.max(1000, device.interval * 1000);
  while (Date.now() < device.expiresAt) {
    await delay(Math.min(interval, Math.max(1, device.expiresAt - Date.now())), undefined, {
      signal,
    });
    if (Date.now() >= device.expiresAt) break;
    const data = await json(
      '/auth/device/token',
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: device.device_code,
        client_id: clientID,
      },
      signal,
    );
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') {
      interval += 5000;
      continue;
    }
    if (data.error)
      throw new Error(
        data.error === 'access_denied'
          ? 'Has rechazado el acceso a OpenCode.'
          : 'El acceso a OpenCode ha caducado o se ha cancelado. Inicia sesión otra vez.',
      );
    const token = tokenSchema.parse(data);
    const [user, orgs] = await Promise.all([
      json('/api/user', undefined, signal, token.access_token),
      json('/api/orgs', undefined, signal, token.access_token),
    ]);
    const organizations = z.array(z.object({ id: z.string(), name: z.string() })).parse(orgs);
    const org = token.org_id
      ? organizations.find((o) => o.id === token.org_id)
      : organizations.sort((a, b) => a.name.localeCompare(b.name))[0];
    if (token.org_id && !org)
      throw new Error('No se encontró la organización autorizada en OpenCode.');
    return {
      kind: 'opencode-oauth',
      access: token.access_token,
      refresh: token.refresh_token,
      expires: Date.now() + token.expires_in * 1000,
      orgID: org?.id,
      orgName: org?.name,
      email: typeof user.email === 'string' ? user.email : undefined,
    };
  }
  throw new Error('El código de OpenCode ha caducado. Inicia sesión otra vez.');
}
export async function refreshCredential(
  json: ConsoleJSON,
  credential: OpenCodeCredential,
): Promise<OpenCodeCredential> {
  const data = await json('/auth/device/token', {
    grant_type: 'refresh_token',
    refresh_token: credential.refresh,
    client_id: clientID,
  });
  if (data.error) throw new Error('La sesión de OpenCode ha caducado. Inicia sesión de nuevo.');
  const token = tokenSchema.parse(data);
  return {
    ...credential,
    access: token.access_token,
    refresh: token.refresh_token,
    expires: Date.now() + token.expires_in * 1000,
    orgID: token.org_id ?? credential.orgID,
  };
}
