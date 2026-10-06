import { z } from 'zod';
import type { AccountState } from '../src/shared';
const claudeStatus = z.object({
  loggedIn: z.boolean(),
  authMethod: z.string().optional(),
  email: z.string().nullish(),
  subscriptionType: z.string().nullish(),
});
const codexStatus = z.object({
  account: z
    .object({ type: z.string(), email: z.string().nullish(), planType: z.string().nullish() })
    .nullable(),
});

export function claudeAccount(value: unknown): Pick<AccountState, 'status' | 'label' | 'plan'> {
  const parsed = claudeStatus.safeParse(value);
  if (!parsed.success)
    throw new Error('Esta versión de Claude Code no devolvió un estado de cuenta válido.');
  const result = parsed.data;
  if (result.loggedIn && result.authMethod !== 'claude.ai')
    throw new Error(
      'Este perfil no usa el acceso de Claude.ai. Cierra sesión y conecta una cuenta con suscripción.',
    );
  return {
    status: result.loggedIn ? 'signedIn' : 'signedOut',
    label: result.loggedIn ? (result.email ?? undefined) : undefined,
    plan: result.loggedIn ? (result.subscriptionType ?? undefined) : undefined,
  };
}
export function codexAccount(value: unknown): Pick<AccountState, 'status' | 'label' | 'plan'> {
  const parsed = codexStatus.safeParse(value);
  if (!parsed.success)
    throw new Error('Esta versión de Codex no devolvió un estado de cuenta válido.');
  const account = parsed.data.account;
  if (account && account.type !== 'chatgpt')
    throw new Error(
      'La autenticación actual no es de ChatGPT. Cierra sesión y conecta tu suscripción.',
    );
  return {
    status: account ? 'signedIn' : 'signedOut',
    label: account?.email ?? undefined,
    plan: account?.planType ?? undefined,
  };
}
