export interface WorkspaceFileEntry {
  path: string;
  name: string;
  kind: 'file' | 'directory';
}
export interface WorkspaceFilesResult {
  root: string;
  entries: WorkspaceFileEntry[];
  truncated: boolean;
}
export interface WorkspaceFileResult {
  root: string;
  path: string;
  content: string;
  language?: string;
  binary: boolean;
  truncated: boolean;
  size: number;
}
export interface WorkspaceDiffResult {
  root: string;
  path: string;
  filePath: string;
  patch: string;
  binary: boolean;
  truncated: boolean;
}
