import { floatingChatAction } from '../src/floating-chat-protocol';
import { mcpConnectionInputSchema } from './mcp-validation';
import { mcpElicitationResult } from '../src/mcp-elicitation';
import { teamInput } from '../src/team-protocol';
import { proxyUpdateSchema } from './proxy';
import { browserInput } from '../src/browser-protocol';
import { z } from 'zod';
import path from 'node:path';
import type { ClaudeConfig, CodexConfig, Session, Profile } from '../src/shared';
import { defaultClaudeConfig, defaultCodexConfig } from '../src/shared';
export const profileSchema = z
  .string()
  .regex(
    /^((?:claude|openrouter|opencode|gemini|local)-[1-9][0-9]{0,3}|codex(?:-[1-9][0-9]{0,3})?)$/,
  )
  .transform((v) => v as Profile);
const id = z.string().min(1).max(150),
  profile = profileSchema;
export const claudeConfigSchema = z.object({
  model: z.string().min(1).max(80),
  fastMode: z.boolean().optional(),
  fallbackModel: z.string().max(80).optional(),
  permissionMode: z.enum([
    'default',
    'acceptEdits',
    'plan',
    'auto',
    'dontAsk',
    'bypassPermissions',
  ]),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  thinking: z.enum(['adaptive', 'enabled', 'disabled']),
  thinkingBudget: z.number().int().min(1024).max(200000).optional(),
  thinkingDisplay: z.enum(['summarized', 'omitted']),
  maxTurns: z.number().int().min(1).max(10000).optional(),
  maxBudgetUsd: z.number().min(0.01).max(10000).optional(),
  appendSystemPrompt: z.string().max(20000),
  allowedTools: z.array(z.string().max(200)).max(200),
  disallowedTools: z.array(z.string().max(200)).max(200),
  settingSources: z.array(z.enum(['user', 'project', 'local'])).max(3),
  additionalDirectories: z.array(z.string().max(1000)).max(50),
  allowBypass: z.boolean(),
  fileCheckpointing: z.boolean(),
});
export const codexConfigSchema = z.object({
  fastMode: z.boolean().optional(),
  model: z.string().min(1).max(80),
  effort: z.string().max(40).optional(),
  approvalPolicy: z.enum(['untrusted', 'on-request', 'never']),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  personality: z.enum(['none', 'friendly', 'pragmatic']),
  developerInstructions: z.string().max(20000),
});
export const optimizationSchema = z
  .object({
    level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    autoModel: z.boolean(),
  })
  .strict();
export const modelSelectionSchema = z
  .object({ freeOnly: z.boolean(), models: z.array(z.string().min(1).max(200)).max(500) })
  .strict();
export const providerConfigSchema = z.object({ model: z.string().min(1).max(1024) }).strict();
export const accountColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i);
export const actionSchema = z.discriminatedUnion('type', [
  floatingChatAction,
  z.object({ type: z.literal('saveMcpConnection'), connection: mcpConnectionInputSchema }).strict(),
  ...(
    [
      'testMcpConnection',
      'deleteMcpConnection',
      'authenticateMcpConnection',
      'cancelMcpAuthentication',
    ] as const
  ).map((type) => z.object({ type: z.literal(type), id }).strict()),
  z
    .object({
      type: z.literal('setProjectMcpConnections'),
      projectId: id,
      connectionIds: z.array(id).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal('setSessionMcpConnections'),
      sessionId: id,
      connectionIds: z.array(id).max(100).nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('openMcpElicitation'),
      sessionId: id,
      requestId: z.union([z.string().max(150), z.number()]),
    })
    .strict(),
  z
    .object({ type: z.literal('localDelete'), profile, model: z.string().min(1).max(1024) })
    .strict(),
  ...(
    [
      'localStatus',
      'localFolder',
      'localInstall',
      'localImport',
      'localCancel',
      'localUnload',
    ] as const
  ).map((type) => z.object({ type: z.literal(type), profile }).strict()),
  z.object({ type: z.literal('localDownload'), profile, url: z.string().url().max(2000) }).strict(),
  z
    .object({
      type: z.literal('localConfigure'),
      profile,
      context: z.number().int().min(2048).max(131072),
      tools: z.boolean(),
      defaultModel: z.string().max(1024).optional(),
      cacheType: z.enum(['q8_0', 'q4_0']).optional(),
    })
    .strict(),
  z.object({ type: z.literal('saveProxy'), config: proxyUpdateSchema }),
  z.object({
    type: z.literal('testProxy'),
    config: proxyUpdateSchema,
    provider: z.enum(['codex', 'claude']),
  }),
  z.object({ type: z.literal('detectProxy') }),
  z.object({ type: z.literal('chooseProxyCertificate') }),
  z.object({ type: z.literal('setDefaultAccount'), profile }),
  z
    .object({ type: z.literal('setAccountColor'), profile, color: accountColorSchema.nullable() })
    .strict(),
  z
    .object({
      type: z.literal('openDevInChrome'),
      sessionId: id,
      port: z.number().int().min(1).max(65535),
    })
    .strict(),
  z.object({ type: z.literal('changeSessionAccount'), sessionId: id, profile }),
  z.object({ type: z.literal('removeAccount'), profile, confirmed: z.literal(true) }),
  z.object({ type: z.literal('configureOptimization'), profile, optimization: optimizationSchema }),
  z.object({
    type: z.literal('addAccount'),
    kind: z.enum(['claude', 'codex', 'openrouter', 'opencode', 'gemini', 'local']),
    name: z.string().trim().min(1).max(40).optional(),
  }),
  z
    .object({
      type: z.literal('connectOpenRouter'),
      profile,
      apiKey: z
        .string()
        .trim()
        .min(10)
        .max(4096)
        .regex(/^[^\s]+$/),
    })
    .strict(),
  z
    .object({
      type: z.literal('providerCatalog'),
      profile,
      category: z
        .enum([
          'programming',
          'roleplay',
          'marketing',
          'science',
          'translation',
          'legal',
          'finance',
          'health',
          'technology',
          'academia',
          'seo',
          'trivia',
        ])
        .optional(),
    })
    .strict(),
  z
    .object({ type: z.literal('selectProviderModels'), profile, selection: modelSelectionSchema })
    .strict(),
  z
    .object({ type: z.literal('configureProvider'), sessionId: id, config: providerConfigSchema })
    .strict(),
  z
    .object({
      type: z.literal('configureGoogleAccount'),
      profile,
      cloudProject: z
        .string()
        .trim()
        .max(100)
        .regex(/^(?:[a-z][a-z0-9-]{4,98}[a-z0-9])?$/),
    })
    .strict(),
  z.object({ type: z.literal('accountOpenLogin'), profile }).strict(),
  z.object({ type: z.literal('snapshot') }),
  z.object({ type: z.literal('deleteSession'), sessionId: id }).strict(),
  z.object({ type: z.literal('browser'), sessionId: id, input: browserInput }),
  z
    .object({
      type: z.literal('chromeConnect'),
      mode: z.enum(['personal', 'managed']),
      projectId: id.optional(),
      sessionId: id.optional(),
    })
    .strict(),
  ...(['chromeDisconnect', 'chromeReconnect'] as const).map((type) =>
    z.object({ type: z.literal(type), connectionId: id }).strict(),
  ),
  z.object({ type: z.literal('chromeFocus'), tabId: id }).strict(),
  z.object({ type: z.literal('chromeSetup') }).strict(),
  z
    .object({
      type: z.literal('chromeNewTab'),
      connectionId: id,
      url: z.string().min(1).max(4096).optional(),
    })
    .strict(),
  ...(['applicationRefresh', 'applicationInstall'] as const).map((type) =>
    z.object({ type: z.literal(type) }).strict(),
  ),
  ...(['applicationOpen', 'applicationReveal'] as const).map((type) =>
    z.object({ type: z.literal(type), id }).strict(),
  ),
  z.object({
    type: z.literal('browserNew'),
    projectId: id.optional(),
    sessionId: id.optional(),
    url: z.string().max(4096).optional(),
  }),
  z.object({ type: z.literal('browserOpenExternal'), tabId: id }).strict(),
  z.object({ type: z.literal('browserTab'), tabId: id, input: browserInput }),
  z.object({ type: z.literal('browserDownloadReveal'), tabId: id, downloadId: id }).strict(),
  z
    .object({
      type: z.literal('browserDownloadControl'),
      tabId: id,
      downloadId: id,
      operation: z.enum(['pause', 'resume', 'cancel']),
    })
    .strict(),
  z
    .object({
      type: z.literal('browserPermission'),
      tabId: id,
      permissionId: id,
      allow: z.boolean(),
    })
    .strict(),
  ...(['browserPick', 'browserCancelPick'] as const).map((type) =>
    z.object({ type: z.literal(type), tabId: id }).strict(),
  ),
  z.object({
    type: z.literal('browserPresent'),
    sessionId: id.optional(),
    tabId: id.optional(),
    visible: z.boolean(),
    bounds: z.object({
      x: z.number().min(0).max(20000),
      y: z.number().min(0).max(20000),
      width: z.number().min(0).max(20000),
      height: z.number().min(0).max(20000),
    }),
  }),
  z.object({ type: z.literal('openProjectTerminal'), projectId: id }),
  z.object({ type: z.literal('openFreebuff'), projectId: id }).strict(),
  z.object({ type: z.literal('setFreebuffEnabled'), enabled: z.boolean() }).strict(),
  z.object({ type: z.literal('stopFreebuff'), projectId: id }).strict(),
  z.object({
    type: z.literal('openPath'),
    projectId: id,
    sessionId: id.optional(),
    path: z.string().trim().min(1).max(4096),
    reveal: z.boolean().optional(),
    workspace: z.boolean().optional(),
  }),
  z.object({ type: z.literal('listFiles'), projectId: id, query: z.string().max(300) }),
  z
    .object({
      type: z.literal('workspaceFiles'),
      projectId: id,
      sessionId: id.optional(),
      directory: z.string().max(4096).optional(),
      query: z.string().max(300).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('workspaceFile'),
      projectId: id,
      sessionId: id.optional(),
      path: z.string().min(1).max(4096),
    })
    .strict(),
  ...(['workspaceDiff', 'workspaceStage'] as const).map((type) =>
    z
      .object({
        type: z.literal(type),
        projectId: id,
        sessionId: id.optional(),
        path: z.string().min(1).max(4096),
        staged: z.boolean(),
      })
      .strict(),
  ),
  z.object({ type: z.literal('setTheme'), theme: z.enum(['system', 'light', 'dark']) }),
  ...(['accountRefresh', 'accountCancel'] as const).map((type) =>
    z.object({ type: z.literal(type), profile }),
  ),
  ...(['accountLogin', 'accountLogout'] as const).map((type) =>
    z.object({ type: z.literal(type), profile, stopSessions: z.boolean() }),
  ),
  z.object({ type: z.literal('restartApp') }),
  z.object({ type: z.literal('refreshCodexModels'), sessionId: id }),
  z.object({ type: z.literal('refreshModels'), sessionId: id }),
  z.object({ type: z.literal('addProject') }),
  z.object({ type: z.literal('moveProject'), projectId: id, targetProjectId: id }).strict(),
  z.object({ type: z.literal('removeProject'), projectId: id }),
  z.object({
    type: z.literal('select'),
    projectId: id,
    sessionId: id.nullable().optional(),
    profile: profile.optional(),
  }),
  z.object({
    type: z.literal('newSession'),
    projectId: id,
    profile: profile.optional(),
    mode: z.enum(['chat', 'terminal']).optional(),
  }),
  ...(['start', 'stop', 'interrupt', 'login', 'cancelLogin'] as const).map((type) =>
    z.object({ type: z.literal(type), sessionId: id }),
  ),
  z.object({ type: z.literal('pickImages'), sessionId: id }),
  z.object({
    type: z.literal('dropImages'),
    sessionId: id,
    images: z
      .array(
        z
          .object({
            name: z.string().min(1).max(255),
            data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
          })
          .strict(),
      )
      .min(1),
  }),
  z.object({
    type: z.literal('discardImages'),
    sessionId: id,
    attachmentIds: z.array(z.string().uuid()),
  }),
  z.object({ type: z.literal('cancelPendingInput'), sessionId: id, messageId: id }).strict(),
  z.object({ type: z.literal('refreshUsage'), profile }),
  z
    .object({
      type: z.literal('send'),
      responseStyle: z.literal('study').optional(),
      sessionId: id,
      text: z.string().trim().max(100000),
      attachmentIds: z.array(z.string().uuid()).optional(),
    })
    .refine(
      (a) => !!a.text || !!a.attachmentIds?.length,
      'Escribe un mensaje o adjunta un archivo.',
    ),
  z.object({
    type: z.literal('approve'),
    sessionId: id,
    requestId: z.union([id, z.number().int()]),
    decision: z.enum(['accept', 'always', 'decline']),
    answers: z.record(z.string(), z.string().max(10000)).optional(),
    message: z.string().max(5000).optional(),
  }),
  z.object({ type: z.literal('configure'), sessionId: id, config: claudeConfigSchema.partial() }),
  z.object({
    type: z.literal('configureCodex'),
    sessionId: id,
    config: codexConfigSchema.partial(),
  }),
  z.object({
    type: z.literal('renameProject'),
    projectId: id,
    name: z.string().trim().min(1).max(80),
  }),
  z.object({ type: z.literal('rename'), sessionId: id, title: z.string().trim().min(1).max(80) }),
  z.object({ type: z.literal('setMode'), sessionId: id, mode: z.enum(['chat', 'terminal']) }),
  z.object({ type: z.literal('continueAntigravity'), sessionId: id }),
  z.object({ type: z.literal('contextUsage'), sessionId: id }),
  z.object({ type: z.literal('terminalWrite'), sessionId: id, data: z.string().max(65536) }),
  z.object({
    type: z.literal('terminalResize'),
    sessionId: id,
    cols: z.number().int().min(2).max(1000),
    rows: z.number().int().min(2).max(1000),
  }),
  z.object({ type: z.literal('terminalBuffer'), sessionId: id }),
  z.object({
    type: z.literal('diff'),
    projectId: id,
    sessionId: id.optional(),
    summaryOnly: z.boolean().optional(),
  }),
  z
    .object({
      type: z.literal('setIsolation'),
      sessionId: id,
      isolation: z.enum(['worktree', 'shared']),
    })
    .strict(),
  z
    .object({
      type: z.literal('worktree'),
      sessionId: id,
      operation: z.enum(['merge', 'update', 'discard']),
    })
    .strict(),
  z.object({ type: z.literal('team'), sessionId: id, input: teamInput }).strict(),
  z.object({ type: z.literal('linkSubchat'), sessionId: id, childId: id }).strict(),
  z.object({ type: z.literal('forkSession'), sessionId: id, isolate: z.boolean() }).strict(),
  z
    .object({
      type: z.literal('rewindFiles'),
      sessionId: id,
      messageId: z.string().min(1).max(200),
      dryRun: z.boolean().optional(),
    })
    .strict(),
  z.object({
    type: z.literal('gitOperation'),
    projectId: id,
    operation: z.enum(['stage', 'unstage', 'commit', 'fetch', 'pull', 'push', 'switch', 'create']),
    value: z.string().min(1).max(4000).optional(),
  }),
  z.object({
    type: z.literal('chooseBinary'),
    tool: z.enum(['claude', 'codex', 'gemini', 'freebuff']),
  }),
  z.object({ type: z.literal('chooseDirectory'), sessionId: id }),
]);
export function cleanEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'PATH',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM_PROGRAM',
    'SSH_AUTH_SOCK',
  ])
    if (source[key]) env[key] = source[key]!;
  // Finder supplies a minimal PATH. Include user-level package managers without
  // sourcing shell startup files, inheriting API secrets or requiring installation.
  const home = source.HOME;
  env.PATH = [
    ...new Set([
      ...(source.PATH ?? '').split(path.delimiter).filter((entry) => path.isAbsolute(entry)),
      ...(home
        ? [
            '.local/bin',
            '.npm-global/bin',
            '.npm/bin',
            '.volta/bin',
            '.asdf/shims',
            '.local/share/mise/shims',
            '.bun/bin',
            '.cargo/bin',
            'Library/pnpm',
          ].map((directory) => path.join(home, directory))
        : []),
      ...[
        source.NVM_BIN,
        source.PNPM_HOME,
        source.VOLTA_HOME && path.join(source.VOLTA_HOME, 'bin'),
      ].filter((entry): entry is string => !!entry && path.isAbsolute(entry)),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ]),
  ].join(path.delimiter);
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}
export function profileDirectory(root: string, profile: string) {
  return path.join(root, 'profiles', profileSchema.parse(profile));
}
/** Arguments for the official interactive CLI (terminal mode). */
export function claudeArgs(s: Pick<Session, 'reference' | 'attempted' | 'forkFrom'>) {
  return [
    ...(s.forkFrom
      ? ['--resume', s.forkFrom, '--fork-session', '--session-id', s.reference!]
      : [s.attempted ? '--resume' : '--session-id', s.reference!]),
    '--setting-sources',
    'user',
    '--settings',
    JSON.stringify({ forceLoginMethod: 'claudeai' }),
  ];
}
export function mergeCodexConfig(config?: Partial<CodexConfig>): CodexConfig {
  return { ...defaultCodexConfig, ...(config ?? {}) };
}
/** Thread-level and turn-level Codex parameters derived from the interface configuration. */
export function codexParams(config: Partial<CodexConfig> | undefined, cwd: string) {
  const c = mergeCodexConfig(config);
  const model = c.model && c.model !== 'default' ? c.model : undefined;
  return {
    thread: {
      cwd,
      approvalPolicy: c.approvalPolicy,
      approvalsReviewer: 'user',
      sandbox: c.sandbox,
      modelProvider: 'openai',
      config: {
        forced_login_method: 'chatgpt',
        'features.fast_mode': true,
        ...(c.fastMode !== undefined ? { service_tier: c.fastMode ? 'fast' : 'default' } : {}),
      },
      ...(model ? { model } : {}),
      ...(c.personality !== 'none' ? { personality: c.personality } : {}),
      ...(c.developerInstructions.trim() ? { developerInstructions: c.developerInstructions } : {}),
    },
    turn: {
      cwd,
      ...(c.fastMode !== undefined ? { serviceTier: c.fastMode ? 'fast' : 'default' } : {}),
      approvalPolicy: c.approvalPolicy,
      approvalsReviewer: 'user',
      // turn/start uses SandboxPolicy, not the SandboxMode accepted by thread/start.
      // Send it every turn so an already loaded thread cannot retain obsolete access.
      sandboxPolicy:
        c.sandbox === 'danger-full-access'
          ? { type: 'dangerFullAccess' as const }
          : c.sandbox === 'read-only'
            ? { type: 'readOnly' as const, networkAccess: false }
            : {
                type: 'workspaceWrite' as const,
                writableRoots: [cwd],
                networkAccess: false,
                excludeTmpdirEnvVar: false,
                excludeSlashTmp: false,
              },
      ...(model ? { model } : {}),
      ...(c.effort ? { effort: c.effort } : {}),
      ...(c.personality !== 'none' ? { personality: c.personality } : {}),
    },
  };
}
export function mergeConfig(config?: Partial<ClaudeConfig>): ClaudeConfig {
  return { ...defaultClaudeConfig, ...(config ?? {}) };
}
/**
 * Translate the interface configuration into Agent SDK options. The result is plain data so
 * tests can check that no provider, key or global configuration leaks into the agent.
 */
export function claudeOptions(
  s: Pick<Session, 'reference' | 'attempted' | 'config' | 'forkFrom'>,
  context: { cwd: string; binary: string; profileDir: string; env?: NodeJS.ProcessEnv },
) {
  const c = mergeConfig(s.config);
  const options: Record<string, unknown> = {
    cwd: context.cwd,
    env: { ...cleanEnv(context.env), CLAUDE_CONFIG_DIR: context.profileDir },
    pathToClaudeCodeExecutable: context.binary,
    settingSources: c.settingSources,
    settings: {
      forceLoginMethod: 'claudeai',
      ...(c.fastMode !== undefined ? { fastMode: c.fastMode } : {}),
    },
    permissionMode: c.permissionMode,
    // Enable switching modes later; the permissionMode above still controls every tool request.
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    // Reuses the prompt cache for a one-line subagent status. Next-prompt suggestions stay off:
    // they rarely matched what the user wanted and only cluttered the composer.
    agentProgressSummaries: true,
    promptSuggestions: false,
    enableFileCheckpointing: c.fileCheckpointing,
    toolConfig: { askUserQuestion: { previewFormat: 'markdown' } },
    thinking:
      c.thinking === 'enabled'
        ? { type: 'enabled', budgetTokens: c.thinkingBudget, display: c.thinkingDisplay }
        : { type: c.thinking, display: c.thinkingDisplay },
  };
  if (s.forkFrom) {
    // Duplicated chat: the CLI copies the source transcript under the new id on first use.
    options.resume = s.forkFrom;
    options.forkSession = true;
    options.sessionId = s.reference;
  } else if (s.attempted) options.resume = s.reference;
  else options.sessionId = s.reference;
  if (c.model && c.model !== 'default') options.model = c.model;
  if (c.fallbackModel) options.fallbackModel = c.fallbackModel;
  if (c.effort) options.effort = c.effort;
  if (c.maxTurns) options.maxTurns = c.maxTurns;
  if (c.maxBudgetUsd) options.maxBudgetUsd = c.maxBudgetUsd;
  if (c.allowedTools.length) options.allowedTools = c.allowedTools;
  if (c.disallowedTools.length) options.disallowedTools = c.disallowedTools;
  if (c.additionalDirectories.length) options.additionalDirectories = c.additionalDirectories;
  if (c.appendSystemPrompt.trim())
    options.systemPrompt = { type: 'preset', preset: 'claude_code', append: c.appendSystemPrompt };
  return options;
}
export function active(s: Session) {
  return ['starting', 'terminal', 'ready', 'working', 'waiting', 'stopping'].includes(s.status);
}
/** Codex approval answers (app-server protocol). */
export function approvalResult(
  method: string,
  params: any,
  decision: 'accept' | 'always' | 'decline',
  answers?: Record<string, string>,
) {
  if (
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval'
  ) {
    const result =
      decision === 'always'
        ? 'acceptForSession'
        : decision === 'decline' &&
            params.availableDecisions?.includes('cancel') &&
            !params.availableDecisions.includes('decline')
          ? 'cancel'
          : decision;
    if (params.availableDecisions && !params.availableDecisions.includes(result))
      throw new Error('Esta decisión no está disponible en el servidor.');
    if (decision === 'always' && !params.availableDecisions?.includes('acceptForSession'))
      throw new Error('El servidor no ofrece autorización para toda la sesión.');
    return { decision: result };
  }
  if (method === 'item/permissions/requestApproval')
    return {
      permissions: decision === 'decline' ? {} : params.permissions,
      scope: decision === 'always' ? 'session' : 'turn',
    };
  if (method === 'item/tool/requestUserInput') {
    const result: Record<string, { answers: string[] }> = {};
    for (const q of params.questions ?? []) {
      const answer = answers?.[q.id];
      if (!answer) throw new Error('Responde a todas las preguntas.');
      result[q.id] = { answers: [answer] };
    }
    return { answers: result };
  }
  if (method === 'mcpServer/elicitation/request')
    return mcpElicitationResult(params, decision, answers);
  throw new Error('Solicitud no compatible con esta versión de Agent Desk. Interrumpe el turno.');
}
/**
 * Claude permission answers (Agent SDK `canUseTool`). "always" reuses the rule suggestions of the
 * CLI when present and otherwise allows the tool for the rest of the session only.
 */
export function permissionResult(
  approval: { tool?: string; input?: any; suggestions?: any[] },
  decision: 'accept' | 'always' | 'decline',
  answers?: Record<string, string>,
  message?: string,
) {
  if (decision === 'decline')
    return {
      behavior: 'deny' as const,
      message: message?.trim() || 'El usuario ha rechazado esta acción.',
    };
  const input = approval.input ?? {};
  if (approval.tool === 'AskUserQuestion') {
    const questions: any[] = input.questions ?? [];
    for (const q of questions)
      if (!answers?.[q.question]) throw new Error('Responde a todas las preguntas.');
    return { behavior: 'allow' as const, updatedInput: { ...input, answers } };
  }
  if (decision === 'always') {
    const updatedPermissions =
      approval.tool === 'ExitPlanMode'
        ? [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
        : approval.suggestions?.length
          ? approval.suggestions
          : [
              {
                type: 'addRules',
                rules: [{ toolName: approval.tool }],
                behavior: 'allow',
                destination: 'session',
              },
            ];
    return { behavior: 'allow' as const, updatedInput: input, updatedPermissions };
  }
  return { behavior: 'allow' as const, updatedInput: input };
}
