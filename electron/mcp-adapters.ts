import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { McpConnection } from '../src/mcp-types';

export interface ResolvedMcpConnection {
  connection: McpConnection;
  env: Record<string, string>;
  headers: Record<string, string>;
}

/** Managed names never replace the coordination server or a user-facing connection name. */
export const managedMcpName = (id: string) => `desk_${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

/** Native MCP transports can echo upstream bodies containing request credentials. */
export function safeMcpRuntimeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /mcp|handshak/i.test(message)
    ? new Error(
        'No se pudo conectar un servidor MCP del chat. Revisa las conexiones y sus credenciales en Ajustes → Conexiones.',
      )
    : error;
}

export function claudeMcpServers(connections: ResolvedMcpConnection[]) {
  const servers: Record<string, McpServerConfig> = {};
  for (const { connection: c, env, headers } of connections) {
    servers[managedMcpName(c.id)] =
      c.transport === 'http'
        ? { type: 'http', url: c.url!, headers }
        : {
            type: 'stdio',
            // Claude has no stdio cwd option. Fixed shell code and positional arguments preserve
            // literal spaces, quotes and shell metacharacters in user commands/arguments.
            command: c.cwd ? '/bin/sh' : c.command!,
            args: c.cwd
              ? [
                  '-c',
                  'cd "$1" && shift && exec "$@"',
                  'agent-desk-mcp',
                  c.cwd,
                  c.command!,
                  ...(c.args ?? []),
                ]
              : (c.args ?? []),
            env,
          };
  }
  return servers;
}

/** Individual override paths preserve MCP servers from native user/project configuration. */
export function codexMcpConfig(connections: ResolvedMcpConnection[]) {
  const config: Record<string, unknown> = {};
  for (const { connection: c, env, headers } of connections)
    config[`mcp_servers.${managedMcpName(c.id)}`] =
      c.transport === 'http'
        ? { url: c.url!, http_headers: headers, required: true }
        : {
            command: c.command!,
            args: c.args ?? [],
            env,
            ...(c.cwd ? { cwd: c.cwd } : {}),
            required: true,
          };
  return config;
}
