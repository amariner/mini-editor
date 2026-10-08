export interface GitSnapshot {
  repository: boolean;
  branch: string;
  detached?: boolean;
  unborn?: boolean;
  upstream?: string;
  remote?: string;
  ahead?: number;
  behind?: number;
  branches: string[];
  files: { path: string; index: string; worktree: string; conflict: boolean }[];
  counts: { staged: number; unstaged: number; untracked: number; conflicts: number };
  status: string;
  staged: string;
  unstaged: string;
  diffError?: string;
  lines?: { added: number; removed: number };
  commits: { hash: string; subject: string }[];
}
export type GitOperation =
  'stage' | 'unstage' | 'commit' | 'fetch' | 'pull' | 'push' | 'switch' | 'create';
