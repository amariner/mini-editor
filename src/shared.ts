import type { BrowserInput, BrowserState } from './browser-protocol';
export type ProviderKind = 'claude' | 'codex' | 'openrouter' | 'opencode' | 'gemini';
export type Profile =
  | `claude-${number}`
  | 'codex'
  | `codex-${number}`
  | `openrouter-${number}`
  | `opencode-${number}`
  | `gemini-${number}`;
export const providerKind = (profile?: string): ProviderKind =>
  profile?.startsWith('opencode-')
    ? 'opencode'
    : profile?.startsWith('openrouter-')
      ? 'openrouter'
      : profile?.startsWith('gemini-')
        ? 'gemini'
        : isCodex(profile)
          ? 'codex'
          : 'claude';
export const isConnectedProvider = (profile?: string) =>
  ['openrouter', 'opencode', 'gemini'].includes(providerKind(profile));
export const providerNames: Record<ProviderKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  openrouter: 'OpenRouter',
  opencode: 'OpenCode',
  gemini: 'Google · Gemini',
};
export interface ProviderConfig {
  model: string;
}
export interface ModelSelection {
  freeOnly: boolean;
  models: string[];
}
export interface ApiUsage {
  spent?: number;
  remaining?: number;
  limit?: number;
  checkedAt: number;
}

export interface ProfileDefinition {
  color?: string;
  id: Profile;
  name: string;
  kind: ProviderKind;
  modelSelection?: ModelSelection;
  googleCloudProject?: string;
  optimization?: TokenOptimization;
}
export interface TokenOptimization {
  level: 0 | 1 | 2 | 3;
  autoModel: boolean;
}
export const defaultOptimization: TokenOptimization = { level: 0, autoModel: false };
export const savingLevels = [
  { value: 0, name: 'Desactivado', hint: 'Usa tus ajustes manuales.' },
  { value: 1, name: 'Suave', hint: 'Respuestas breves y sin repeticiones; conserva el esfuerzo.' },
  {
    value: 2,
    name: 'Equilibrado',
    hint: 'Respuesta directa, búsquedas acotadas y esfuerzo moderado.',
  },
  { value: 3, name: 'Intenso', hint: 'Solo lo esencial y menor esfuerzo en tareas sencillas.' },
] as const;
export type Theme = 'system' | 'light' | 'dark';
export const isCodex = (profile?: string) => profile === 'codex' || !!profile?.startsWith('codex-');
// Only used to restore state written before profiles were stored explicitly.
export const legacyProfiles: ProfileDefinition[] = [
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
  {
    id: 'dontAsk',
    name: 'Rechazar sin preguntar',
    hint: 'Bloquea las acciones que necesitan permiso.',
  },
  {
    id: 'bypassPermissions',
    name: 'Omitir permisos',
    hint: 'Autoriza automáticamente las herramientas.',
  },
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
  {
    id: 'never',
    name: 'Rechazar sin preguntar',
    hint: 'No pide aprobación: bloquea las acciones fuera del acceso seleccionado.',
  },
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
      /** Wall-clock start and duration, recorded by the app while the tool runs. */
      at?: number;
      ms?: number;
      children?: Block[];
    };
/** Structured view of a Codex item; `text` keeps the legacy flat rendering. */
export interface ToolInfo {
  kind: 'command' | 'edit' | 'mcp' | 'web';
  status?: string;
  command?: string;
  output?: string;
  exitCode?: number;
  durationMs?: number;
  /** Codex's own parse of a shell command (read/listFiles/search/unknown). */
  actions?: { type: string; path?: string; query?: string }[];
  files?: { path: string; kind: string; diff: string }[];
  server?: string;
  tool?: string;
  query?: string;
}
export interface Attachment {
  id: string;
  name: string;
  preview?: string;
  mediaType?: string;
  size?: number;
}
export interface Message {
  attachments?: Attachment[];
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  blocks?: Block[];
  kind?: 'result' | 'compact' | 'info' | 'error' | 'command' | 'warning';
  model?: string;
  at?: number;
  /** Provider-reported duration of the turn that ends with this message. */
  durationMs?: number;
  tool?: ToolInfo;
  /** UUID the Claude CLI stores for this user message; `rewindFiles` restores files to it. */
  checkpoint?: string;
}
/** Result of Claude's `rewindFiles` (dry run or real). */
export interface RewindResult {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
  skippedLinks?: number;
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
  categories?: string[];
  tools?: boolean;
  image?: boolean;
  free?: boolean;
  inputPrice?: number;
  outputPrice?: number;
  contextLength?: number;
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
  costReported?: boolean;
  costEstimated?: boolean;
  tokensReported?: boolean;
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
  accountLocked?: boolean;
  optimization?: {
    model: string;
    effort?: string;
    reason: string;
    level: number;
    autoModel: boolean;
  };
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
  providerConfig?: ProviderConfig;
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
  /** Running subagents and their latest progress summary (Agent SDK task_* events). */
  subagents?: { id: string; description: string; summary?: string; tool?: string }[];
  /** Predicted next prompt; filling the draft with it is the user's choice. */
  suggestion?: string;
  /** Explicit choice for Claude chats; undefined follows the default (isolate when others run). */
  isolation?: 'worktree' | 'shared';
  worktree?: import('./git-types').SessionWorktree;
  /** Claude session to fork on the next start (`resume` + `forkSession`). */
  forkFrom?: string;
  /** Chat this one was duplicated from. */
  forkOf?: string;
}
export interface AccountState {
  apiUsage?: ApiUsage;
  usage?: import('./subscription-usage').SubscriptionUsage;
  status: 'unknown' | 'signedIn' | 'signedOut';
  label?: string;
  plan?: string;
  busy?: 'checking' | 'signingIn' | 'verifying' | 'signingOut' | 'cancelling' | 'removing';
  error?: string;
  terminalId?: string;
  cancellable?: boolean;
  loginCode?: string;
  loginUrl?: string;
  loginStarting?: boolean;
}
export interface Snapshot {
  freebuffEnabled?: boolean;
  theme?: Theme;
  proxy?: import('./proxy-types').ProxySnapshot;
  defaultProfile?: Profile;
  profiles?: ProfileDefinition[];
  removedProfiles?: Profile[];
  browsers?: BrowserState[];
  devServers?: { projectId: string; sessionId: string; url: string; port: number }[];
  terminals?: { id: string; projectId: string; status: Status; kind?: 'shell' | 'freebuff' }[];
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
  tools: { claude?: string; codex?: string; gemini?: string; freebuff?: string };
  dataDir: string;
  notice?: string;
}
export type Action =
  | { type: 'setFreebuffEnabled'; enabled: boolean }
  | { type: 'saveProxy'; config: import('./proxy-types').ProxyUpdate }
  | { type: 'testProxy'; config: import('./proxy-types').ProxyUpdate; provider: 'codex' | 'claude' }
  | { type: 'detectProxy' | 'chooseProxyCertificate' }
  | { type: 'setDefaultAccount'; profile: Profile }
  | { type: 'setAccountColor'; profile: Profile; color: string | null }
  | { type: 'openDevInChrome'; sessionId: string; port: number }
  | { type: 'changeSessionAccount'; sessionId: string; profile: Profile }
  | { type: 'configureOptimization'; profile: Profile; optimization: TokenOptimization }
  | { type: 'addAccount'; kind: ProviderKind; name?: string }
  | { type: 'accountOpenLogin'; profile: Profile }
  | { type: 'connectOpenRouter'; profile: Profile; apiKey: string }
  | { type: 'configureGoogleAccount'; profile: Profile; cloudProject: string }
  | { type: 'providerCatalog'; profile: Profile; category?: string }
  | { type: 'selectProviderModels'; profile: Profile; selection: ModelSelection }
  | { type: 'configureProvider'; sessionId: string; config: ProviderConfig }
  | { type: 'browser'; sessionId: string; input: BrowserInput }
  | { type: 'browserNew'; projectId?: string; sessionId?: string; url?: string }
  | { type: 'browserOpenExternal'; tabId: string }
  | { type: 'browserTab'; tabId: string; input: BrowserInput }
  | {
      type: 'browserPresent';
      sessionId?: string;
      tabId?: string;
      visible: boolean;
      bounds: { x: number; y: number; width: number; height: number };
    }
  | { type: 'openProjectTerminal'; projectId: string }
  | { type: 'openFreebuff' | 'stopFreebuff'; projectId: string }
  | { type: 'openPath'; projectId: string; sessionId?: string; path: string; reveal?: boolean }
  | { type: 'listFiles'; projectId: string; query: string }
  | { type: 'setTheme'; theme: Theme }
  | { type: 'accountRefresh' | 'accountCancel'; profile: Profile }
  | { type: 'accountLogin' | 'accountLogout'; profile: Profile; stopSessions: boolean }
  | { type: 'removeAccount'; profile: Profile; confirmed: true }
  | { type: 'snapshot' }
  | { type: 'restartApp' }
  | { type: 'addProject' }
  | { type: 'moveProject'; projectId: string; targetProjectId: string }
  | { type: 'removeProject'; projectId: string }
  | { type: 'renameProject'; projectId: string; name: string }
  | { type: 'select'; projectId: string; sessionId?: string; profile?: Profile }
  | { type: 'newSession'; projectId: string; profile?: Profile; mode?: 'chat' | 'terminal' }
  | { type: 'start' | 'stop' | 'interrupt' | 'login' | 'cancelLogin'; sessionId: string }
  | { type: 'pickImages'; sessionId: string }
  | { type: 'dropImages'; sessionId: string; images: { name: string; data: string }[] }
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
  | { type: 'refreshModels'; sessionId: string }
  | { type: 'configureCodex'; sessionId: string; config: Partial<CodexConfig> }
  | { type: 'rename'; sessionId: string; title: string }
  | { type: 'setMode'; sessionId: string; mode: 'chat' | 'terminal' }
  | { type: 'continueAntigravity'; sessionId: string }
  | { type: 'contextUsage'; sessionId: string }
  | { type: 'terminalWrite'; sessionId: string; data: string }
  | { type: 'terminalResize'; sessionId: string; cols: number; rows: number }
  | { type: 'terminalBuffer'; sessionId: string }
  | { type: 'diff'; projectId: string; sessionId?: string }
  | { type: 'setIsolation'; sessionId: string; isolation: 'worktree' | 'shared' }
  | { type: 'worktree'; sessionId: string; operation: 'merge' | 'update' | 'discard' }
  | { type: 'forkSession'; sessionId: string; isolate: boolean }
  | { type: 'rewindFiles'; sessionId: string; messageId: string; dryRun?: boolean }
  | {
      type: 'gitOperation';
      projectId: string;
      operation: import('./git-types').GitOperation;
      value?: string;
    }
  | { type: 'chooseBinary'; tool: 'claude' | 'codex' | 'gemini' | 'freebuff' }
  | { type: 'chooseDirectory'; sessionId: string };
export type DeskEvent =
  | { type: 'shortcut'; action: 'search' | 'settings' | 'resetStyles' }
  | { type: 'browserOpened'; sessionId: string; tabId?: string }
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
