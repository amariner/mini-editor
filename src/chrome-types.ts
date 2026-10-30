export type ChromeMode = 'personal' | 'managed';
export interface ChromeConnection {
  id: string;
  mode: ChromeMode;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  projectId?: string;
  sessionId?: string;
  error?: string;
  executable?: string;
  profilePath?: string;
  connectedAt?: number;
  tabCount: number;
}
