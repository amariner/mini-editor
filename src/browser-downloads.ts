export interface BrowserDownload {
  id: string;
  tabId: string;
  projectId?: string;
  sessionId: string;
  fileName: string;
  state: 'progress' | 'paused' | 'completed' | 'cancelled' | 'interrupted';
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
  canResume: boolean;
  canPause?: boolean;
  canCancel?: boolean;
  /** Only published after Chromium reports a successfully saved file. */
  path?: string;
  error?: string;
}
