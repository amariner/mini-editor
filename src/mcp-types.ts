import type { Project, Session } from './shared';

export type McpTransport = 'http' | 'stdio';
export type McpAuth = 'none' | 'headers' | 'oauth';
export interface McpConnectionInput {
  id?: string;
  name: string;
  identity?: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  auth?: McpAuth;
  /** Omit to retain saved values; null clears them. Values never return in snapshots. */
  env?: Record<string, string> | null;
  headers?: Record<string, string> | null;
}
export interface McpConnection {
  id: string;
  name: string;
  identity?: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  auth: McpAuth;
  envKeys: string[];
  headerKeys: string[];
  revision: number;
  status: 'unchecked' | 'checking' | 'connected' | 'error' | 'needs-auth';
  tools?: { name: string; description?: string }[];
  checkedAt?: number;
  error?: string;
  authenticating?: boolean;
}
export type McpAction =
  | { type: 'openMcpElicitation'; sessionId: string; requestId: string | number }
  | { type: 'saveMcpConnection'; connection: McpConnectionInput }
  | {
      type:
        | 'testMcpConnection'
        | 'deleteMcpConnection'
        | 'authenticateMcpConnection'
        | 'cancelMcpAuthentication';
      id: string;
    }
  | { type: 'setProjectMcpConnections'; projectId: string; connectionIds: string[] }
  | { type: 'setSessionMcpConnections'; sessionId: string; connectionIds: string[] | null };

export function effectiveMcpIds(
  project: Pick<Project, 'mcpConnectionIds'> | undefined,
  session?: Pick<Session, 'mcpConnectionIds'>,
) {
  return session?.mcpConnectionIds ?? project?.mcpConnectionIds ?? [];
}
export function supportsManagedMcp(profile: string, mode?: string) {
  return mode !== 'terminal' && (/^claude-/.test(profile) || /^codex(?:-|$)/.test(profile));
}
