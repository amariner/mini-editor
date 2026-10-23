import path from 'node:path';
import { z } from 'zod';
import { validateMcpUrl } from './mcp-auth';

const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !/[\0\r\n]/.test(value), 'El texto contiene caracteres no válidos.');
const secrets = (headers: boolean) =>
  z.record(z.string(), z.string()).superRefine((values, ctx) => {
    const entries = Object.entries(values);
    if (entries.length > 100 || JSON.stringify(values).length > 131072)
      ctx.addIssue({ code: 'custom', message: 'Demasiadas credenciales o variables.' });
    for (const [key, value] of entries) {
      const validKey = headers ? /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/ : /^[A-Za-z_][A-Za-z0-9_]*$/;
      if (
        !validKey.test(key) ||
        key.length > 256 ||
        ['__proto__', 'constructor', 'prototype'].includes(key) ||
        value.length > 32768 ||
        /\0/.test(value) ||
        (headers && /[\r\n]/.test(value))
      )
        ctx.addIssue({ code: 'custom', message: 'Nombre o valor de credencial no válido.' });
      if (
        headers &&
        /^(host|content-length|connection|transfer-encoding|upgrade|mcp-session-id|mcp-protocol-version)$/i.test(
          key,
        )
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Esa cabecera está reservada por el transporte MCP.',
        });
    }
  });

export const mcpConnectionInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: text(120).trim().min(1),
    identity: text(200).trim().optional(),
    transport: z.enum(['http', 'stdio']),
    url: text(4096).trim().optional(),
    command: text(4096).trim().optional(),
    args: z
      .array(
        z
          .string()
          .max(8192)
          .refine((value) => !value.includes('\0'), 'Argumento no válido.'),
      )
      .max(100)
      .optional(),
    cwd: text(4096).trim().optional(),
    auth: z.enum(['none', 'headers', 'oauth']).optional(),
    env: secrets(false).nullable().optional(),
    headers: secrets(true).nullable().optional(),
  })
  .superRefine((input, ctx) => {
    if (input.transport === 'http') {
      try {
        const url = new URL(input.url ?? '');
        validateMcpUrl(url);
        if (
          [...url.searchParams.keys()].some((key) =>
            /^(access_token|token|api[_-]?key|secret|password|authorization)$/i.test(key),
          )
        )
          throw new Error('Introduce las credenciales en las cabeceras, no en la URL.');
      } catch {
        ctx.addIssue({
          code: 'custom',
          path: ['url'],
          message: 'Usa una URL HTTPS sin credenciales; HTTP solo se admite en localhost.',
        });
      }
    } else {
      if (!input.command || /[\n\r\0|;&<>`$]/.test(input.command))
        ctx.addIssue({
          code: 'custom',
          path: ['command'],
          message: 'Indica un ejecutable; utiliza el campo de argumentos para sus opciones.',
        });
      if (input.cwd && !path.isAbsolute(input.cwd))
        ctx.addIssue({
          code: 'custom',
          path: ['cwd'],
          message: 'El directorio de trabajo debe ser una ruta absoluta.',
        });
      if (input.auth && input.auth !== 'none')
        ctx.addIssue({
          code: 'custom',
          path: ['auth'],
          message: 'Los servidores locales utilizan variables de entorno.',
        });
    }
  });
