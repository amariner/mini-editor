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
  /** Present when the snapshot belongs to a chat isolated in a worktree. */
  worktree?: WorktreeStatus;
}
export type GitOperation =
  'stage' | 'unstage' | 'commit' | 'fetch' | 'pull' | 'push' | 'switch' | 'create';
/** A git worktree + branch that isolates one chat from the main checkout. */
export interface SessionWorktree {
  /** Worktree checkout (top level). */
  path: string;
  /** Agent working directory: the project folder inside the worktree. */
  cwd: string;
  branch: string;
  /** Branch of the main checkout the worktree was created from; merges go back there. */
  base: string;
  baseCommit: string;
  /** Main repository top level. */
  root: string;
  createdAt: number;
}
export interface WorktreeStatus {
  exists: boolean;
  branch: string;
  base: string;
  /** Branch currently checked out in the main repository. */
  mainBranch?: string;
  /** Commits of the worktree branch not yet in the base branch. */
  ahead: number;
  /** Commits of the base branch not yet in the worktree branch. */
  behind: number;
  /** Uncommitted files in the worktree. */
  dirty: number;
  conflicts: number;
}
export interface WorktreeMergeResult {
  merged: boolean;
  upToDate?: boolean;
  /** Files that would conflict; nothing was changed in the main checkout. */
  conflicts?: string[];
  commit?: string;
  message: string;
}
