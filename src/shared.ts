import type { BrowserInput, BrowserState } from './browser-protocol';
export type Profile = `claude-${number}` | 'codex' | `codex-${number}`;
export interface ProfileDefinition {
  id: Profile;
  name: string;
  kind: 'claude' | 'codex';
}
export const isCodex = (profile?: string) => profile === 'codex' || !!profile?.startsWith('codex-');
export const profiles: ProfileDefinition[] = [
  { id: 'claude-1', name: 'Claude 1', kind: 'claude' },
  { id: 'claude-2', name: 'Claude 2', kind: 'claude' },
  { id: 'codex', name: 'Codex', kind: 'codex' },
];
export type Status =
  'stopped' | 'starting' | 'terminal' | 'ready' | 'working' | 'waiting' | 'stopping' | 'error';
export interface Project {
  id: string;
  name: string;
  path: string;
}
export type PermissionMode =
  'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type SettingSource = 'user' | 'project' | 'local';
/** Everything Claude Code lets you configure, chosen from the interface instead of flags. */
export interface ClaudeConfig {
  model: string;
  fallbackModel?: string;
  permissionMode: PermissionMode;
  effort?: Effort;
  thinking: 'adaptive' | 'enabled' | 'disabled';
  thinkingBudget?: number;
  thinkingDisplay: 'summarized' | 'omitted';
  maxTurns?: number;
  maxBudgetUsd?: number;
  appendSystemPrompt: string;
  allowedTools: string[];
  disallowedTools: string[];
  settingSources: SettingSource[];
  additionalDirectories: string[];
  allowBypass: boolean;
  fileCheckpointing: boolean;
}
export const defaultClaudeConfig: ClaudeConfig = {
  model: 'default',
  permissionMode: 'default',
  thinking: 'adaptive',
  thinkingDisplay: 'summarized',
  appendSystemPrompt: '',
  allowedTools: [],
  disallowedTools: [],
  settingSources: ['user'],
  additionalDirectories: [],
  allowBypass: false,
  fileCheckpointing: true,
};
export const permissionModes: { id: PermissionMode; name: string; hint: string }[] = [
  { id: 'default', name: 'Preguntar', hint: 'Pide permiso para cada acción sensible.' },
  { id: 'acceptEdits', name: 'Aceptar ediciones', hint: 'Edita archivos sin preguntar.' },
  { id: 'plan', name: 'Plan', hint: 'Solo lee y propone un plan antes de actuar.' },
  { id: 'auto', name: 'Automático', hint: 'Claude decide con un clasificador de seguridad.' },
  { id: 'dontAsk', name: 'No preguntar', hint: 'Rechaza lo que necesitaría permiso.' },
  { id: 'bypassPermissions', name: 'Sin permisos', hint: 'Omite todas las comprobaciones.' },
];
export const efforts: { id: Effort; name: string }[] = [
  { id: 'low', name: 'Bajo' },
  { id: 'medium', name: 'Medio' },
  { id: 'high', name: 'Alto' },
  { id: 'xhigh', name: 'Muy alto' },
  { id: 'max', name: 'Máximo' },
];
export type CodexApproval = 'untrusted' | 'on-request' | 'never';
export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';
/** Everything the Codex app-server lets a client choose per thread and per turn. */
export interface CodexConfig {
  model: string;
  effort?: string;
  approvalPolicy: CodexApproval;
  sandbox: CodexSandbox;
  personality: 'none' | 'friendly' | 'pragmatic';
  developerInstructions: string;
}
export const defaultCodexConfig: CodexConfig = {
  model: 'default',
  approvalPolicy: 'untrusted',
  sandbox: 'workspace-write',
  personality: 'none',
  developerInstructions: '',
};
export const codexApprovals: { id: CodexApproval; name: string; hint: string }[] = [
  { id: 'untrusted', name: 'Preguntar', hint: 'Pide aprobación salvo para comandos de confianza.' },
  { id: 'on-request', name: 'A petición', hint: 'Codex decide cuándo pedir aprobación.' },
  { id: 'never', name: 'Nunca', hint: 'No pide aprobación; el sandbox sigue vigente.' },
];
export const codexSandboxes: { id: CodexSandbox; name: string; hint: string }[] = [
  { id: 'read-only', name: 'Solo lectura', hint: 'No puede modificar archivos.' },
  { id: 'workspace-write', name: 'Escribir en el proyecto', hint: 'Edita dentro de la carpeta.' },
  {
    id: 'danger-full-access',
    name: 'Acceso total',
    hint: 'Sin sandbox. Solo en entornos aislados.',
  },
];
export type Block =
  | { type: 'text'; text: string; final?: boolean }
  | { type: 'thinking'; text: string; final?: boolean }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: any;
      partial?: string;
      final?: boolean;
      result?: string;
      isError?: boolean;
      done?: boolean;
      elapsed?: number;
      children?: Block[];
    };
export interface ImageAttachment {
  id: string;
  name: string;
  preview: string;
}
export interface Message {
  attachments?: ImageAttachment[];
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  blocks?: Block[];
  kind?: 'result' | 'compact' | 'info' | 'error' | 'command' | 'warning';
  model?: string;
  at?: number;
}
export interface Approval {
  id: string | number;
  method: string;
  params: Record<string, any>;
  /** Claude permission requests carry the tool and the rule suggestions of the CLI. */
  tool?: string;
  input?: any;
  suggestions?: any[];
  title?: string;
  reason?: string;
  blockedPath?: string;
}
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  builtin?: boolean;
}
export interface ModelInfo {
  isDefault?: boolean;
  defaultEffort?: string;
  value: string;
  displayName: string;
  description: string;
  supportedEffortLevels?: string[];
}
export interface McpServer {
  name: string;
  status: string;
  tools?: number;
  error?: string;
}
export interface SessionInfo {
  version?: string;
  model?: string;
  tools: string[];
  commands: SlashCommand[];
  models: ModelInfo[];
  mcpServers: McpServer[];
  skills: string[];
  plugins: string[];
  agents: string[];
  outputStyle?: string;
  outputStyles: string[];
  permissionMode?: PermissionMode;
  effort?: Effort | null;
  apiKeySource?: string;
  account?: { email?: string; organization?: string; subscriptionType?: string };
}
export interface SessionStats {
  cost: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  contextTokens?: number;
  contextMax?: number;
  contextPercent?: number;
  linesAdded?: number;
  linesRemoved?: number;
}
export interface RateLimit {
  fiveHour?: number;
  sevenDay?: number;
  resetsAt?: number;
  status?: string;
}
export interface Session {
  modelsLoading?: boolean;
  modelsError?: string;
  id: string;
  projectId: string;
  profile: Profile;
  title: string;
  reference?: string;
  attempted?: boolean;
  mode?: 'chat' | 'terminal';
  config?: ClaudeConfig;
  codexConfig?: CodexConfig;
  status: Status;
  messages: Message[];
  approvals: Approval[];
  error?: string;
  turnId?: string;
  account?: string;
  loginPending?: boolean;
  info?: SessionInfo;
  stats?: SessionStats;
  rateLimit?: RateLimit;
  activity?: string;
  notice?: string;
  todos?: { content: string; status: string; activeForm?: string }[];
  tasks?: { id: string; description: string }[];
}
export interface AccountState {
  usage?: import('./subscription-usage').SubscriptionUsage;
  status: 'unknown' | 'signedIn' | 'signedOut';
  label?: string;
  plan?: string;
  busy?: 'checking' | 'signingIn' | 'signingOut' | 'cancelling';
  error?: string;
  terminalId?: string;
  cancellable?: boolean;
}
export interface Snapshot {
  profiles?: ProfileDefinition[];
  browsers?: BrowserState[];
  terminals?: { id: string; projectId: string; status: Status }[];
  coordination?: {
    sessionId: string;
    projectId: string;
    profile: Profile;
    title: string;
    status: Status;
    task: string;
    paths: string[];
  }[];
  accounts?: Record<Profile, AccountState>;
  runtime?: { protocol: number; updateAvailable: boolean; restartSupported: boolean };
  projects: Project[];
  sessions: Session[];
  selectedProject?: string;
  selectedSession?: string;
  tools: { claude?: string; codex?: string };
  dataDir: string;
  notice?: string;
}
export type Action =
  | { type: 'addAccount'; kind: 'claude' | 'codex'; name?: string }
  | { type: 'browser'; sessionId: string; input: BrowserInput }
  | {
      type: 'browserPresent';
      sessionId: string;
      visible: boolean;
      bounds: { x: number; y: number; width: number; height: number };
    }
  | { type: 'openProjectTerminal'; projectId: string }
  | { type: 'accountRefresh' | 'accountCancel'; profile: Profile }
  | { type: 'accountLogin' | 'accountLogout'; profile: Profile; stopSessions: boolean }
  | { type: 'snapshot' }
  | { type: 'restartApp' }
  | { type: 'addProject' }
  | { type: 'removeProject'; projectId: string }
  | { type: 'renameProject'; projectId: string; name: string }
  | { type: 'select'; projectId: string; sessionId?: string; profile?: Profile }
  | { type: 'newSession'; projectId: string; profile: Profile; mode?: 'chat' | 'terminal' }
  | { type: 'start' | 'stop' | 'interrupt' | 'login' | 'cancelLogin'; sessionId: string }
  | { type: 'pickImages'; sessionId: string }
  | { type: 'discardImages'; sessionId: string; attachmentIds: string[] }
  | { type: 'refreshUsage'; profile: Profile }
  | { type: 'send'; sessionId: string; text: string; attachmentIds?: string[] }
  | {
      type: 'approve';
      sessionId: string;
      requestId: string | number;
      decision: 'accept' | 'always' | 'decline';
      answers?: Record<string, string>;
      message?: string;
    }
  | { type: 'configure'; sessionId: string; config: Partial<ClaudeConfig> }
  | { type: 'refreshCodexModels'; sessionId: string }
  | { type: 'configureCodex'; sessionId: string; config: Partial<CodexConfig> }
  | { type: 'rename'; sessionId: string; title: string }
  | { type: 'setMode'; sessionId: string; mode: 'chat' | 'terminal' }
  | { type: 'contextUsage'; sessionId: string }
  | { type: 'terminalWrite'; sessionId: string; data: string }
  | { type: 'terminalResize'; sessionId: string; cols: number; rows: number }
  | { type: 'terminalBuffer'; sessionId: string }
  | { type: 'diff'; projectId: string }
  | { type: 'chooseBinary'; tool: 'claude' | 'codex' }
  | { type: 'chooseDirectory'; sessionId: string };
export type DeskEvent =
  | { type: 'shortcut'; action: 'search' | 'settings' }
  | { type: 'browserOpened'; sessionId: string }
  | { type: 'state'; state: Snapshot }
  | { type: 'terminal'; sessionId: string; data: string; sequence: number };
export interface DeskAPI {
  invoke(action: Action): Promise<any>;
  subscribe(fn: (event: DeskEvent) => void): () => void;
}
declare global {
  interface Window {
    desk: DeskAPI;
  }
}
