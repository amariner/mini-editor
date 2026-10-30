export interface ApplicationInfo {
  id: string;
  name: string;
  path: string;
  kind: 'app' | 'cli';
  scope: 'user' | 'system';
  version?: string;
  bundleId?: string;
  capabilities: string[];
}

export interface ApplicationSnapshot {
  items: ApplicationInfo[];
  supported: boolean;
  installDirectory: string;
  busy?: 'refreshing' | 'installing';
  error?: string;
  updatedAt?: number;
  lastInstalled?: string;
}

export type ApplicationAction =
  | { type: 'applicationRefresh' | 'applicationInstall' }
  | { type: 'applicationOpen' | 'applicationReveal'; id: string };
