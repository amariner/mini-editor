import { browserInput } from '../src/browser-protocol';
import { z } from 'zod';
import path from 'node:path';
import type { ClaudeConfig, CodexConfig, Session, Profile } from '../src/shared';
import { defaultClaudeConfig, defaultCodexConfig } from '../src/shared';
export const profileSchema = z
  .string()
  .regex(/^(claude-[1-9][0-9]{0,3}|codex(?:-[1-9][0-9]{0,3})?)$/)
  .transform((v) => v as Profile);
const id = z.string().min(1).max(150),
  profile = profileSchema;
export const claudeConfigSchema = z.object({
  model: z.string().min(1).max(80),
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
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('configureOptimization'), profile, optimization: optimizationSchema }),
  z.object({
    type: z.literal('addAccount'),
    kind: z.enum(['claude', 'codex']),
    name: z.string().trim().min(1).max(40).optional(),
  }),
  z.object({ type: z.literal('snapshot') }),
  z.object({ type: z.literal('browser'), sessionId: id, input: browserInput }),
  z.object({
    type: z.literal('browserNew'),
    projectId: id.optional(),
    sessionId: id.optional(),
    url: z.string().max(4096).optional(),
  }),
  z.object({ type: z.literal('browserTab'), tabId: id, input: browserInput }),
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
  ...(['accountRefresh', 'accountCancel'] as const).map((type) =>
    z.object({ type: z.literal(type), profile }),
  ),
  ...(['accountLogin', 'accountLogout'] as const).map((type) =>
    z.object({ type: z.literal(type), profile, stopSessions: z.boolean() }),
  ),
  z.object({ type: z.literal('restartApp') }),
  z.object({ type: z.literal('refreshCodexModels'), sessionId: id }),
  z.object({ type: z.literal('addProject') }),
  z.object({ type: z.literal('removeProject'), projectId: id }),
  z.object({
    type: z.literal('select'),
    projectId: id,
    sessionId: id.optional(),
    profile: profile.optional(),
  }),
  z.object({
    type: z.literal('newSession'),
    projectId: id,
    profile,
    mode: z.enum(['chat', 'terminal']).optional(),
  }),
  ...(['start', 'stop', 'interrupt', 'login', 'cancelLogin'] as const).map((type) =>
    z.object({ type: z.literal(type), sessionId: id }),
  ),
  z.object({ type: z.literal('pickImages'), sessionId: id }),
  z.object({
    type: z.literal('discardImages'),
    sessionId: id,
    attachmentIds: z.array(z.string().uuid()).max(4),
  }),
  z.object({ type: z.literal('refreshUsage'), profile }),
  z
    .object({
      type: z.literal('send'),
      sessionId: id,
      text: z.string().trim().max(100000),
      attachmentIds: z.array(z.string().uuid()).max(4).optional(),
    })
    .refine(
      (a) => !!a.text || !!a.attachmentIds?.length,
      'Escribe un mensaje o adjunta una imagen.',
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
  z.object({ type: z.literal('contextUsage'), sessionId: id }),
  z.object({ type: z.literal('terminalWrite'), sessionId: id, data: z.string().max(65536) }),
  z.object({
    type: z.literal('terminalResize'),
    sessionId: id,
    cols: z.number().int().min(2).max(1000),
    rows: z.number().int().min(2).max(1000),
  }),
  z.object({ type: z.literal('terminalBuffer'), sessionId: id }),
  z.object({ type: z.literal('diff'), projectId: id }),
  z.object({ type: z.literal('chooseBinary'), tool: z.enum(['claude', 'codex']) }),
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
  env.PATH = [
    source.PATH ?? '',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    path.join(source.HOME ?? '', '/.local/bin'),
  ].join(':');
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}
export function profileDirectory(root: string, profile: string) {
  return path.join(root, 'profiles', profileSchema.parse(profile));
}
/** Arguments for the official interactive CLI (terminal mode). */
export function claudeArgs(s: Pick<Session, 'reference' | 'attempted'>) {
  return [
    s.attempted ? '--resume' : '--session-id',
    s.reference!,
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
      config: { forced_login_method: 'chatgpt' },
      ...(model ? { model } : {}),
      ...(c.personality !== 'none' ? { personality: c.personality } : {}),
      ...(c.developerInstructions.trim() ? { developerInstructions: c.developerInstructions } : {}),
    },
    turn: {
      cwd,
      approvalPolicy: c.approvalPolicy,
      approvalsReviewer: 'user',
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
  s: Pick<Session, 'reference' | 'attempted' | 'config'>,
  context: { cwd: string; binary: string; profileDir: string; env?: NodeJS.ProcessEnv },
) {
  const c = mergeConfig(s.config);
  const options: Record<string, unknown> = {
    cwd: context.cwd,
    env: { ...cleanEnv(context.env), CLAUDE_CONFIG_DIR: context.profileDir },
    pathToClaudeCodeExecutable: context.binary,
    settingSources: c.settingSources,
    settings: { forceLoginMethod: 'claudeai' },
    permissionMode: c.permissionMode,
    includePartialMessages: true,
    enableFileCheckpointing: c.fileCheckpointing,
    toolConfig: { askUserQuestion: { previewFormat: 'markdown' } },
    thinking:
      c.thinking === 'enabled'
        ? { type: 'enabled', budgetTokens: c.thinkingBudget, display: c.thinkingDisplay }
        : { type: c.thinking, display: c.thinkingDisplay },
  };
  if (s.attempted) options.resume = s.reference;
  else options.sessionId = s.reference;
  if (c.model && c.model !== 'default') options.model = c.model;
  if (c.fallbackModel) options.fallbackModel = c.fallbackModel;
  if (c.effort) options.effort = c.effort;
  if (c.maxTurns) options.maxTurns = c.maxTurns;
  if (c.maxBudgetUsd) options.maxBudgetUsd = c.maxBudgetUsd;
  if (c.allowedTools.length) options.allowedTools = c.allowedTools;
  if (c.disallowedTools.length) options.disallowedTools = c.disallowedTools;
  if (c.additionalDirectories.length) options.additionalDirectories = c.additionalDirectories;
  if (c.allowBypass || c.permissionMode === 'bypassPermissions')
    options.allowDangerouslySkipPermissions = true;
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
  if (decision === 'always') decision = 'accept';
  if (
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval'
  ) {
    if (params.availableDecisions && !params.availableDecisions.includes(decision))
      throw new Error('Esta decisión no está disponible en el servidor.');
    return { decision };
  }
  if (method === 'item/permissions/requestApproval')
    return { permissions: decision === 'accept' ? params.permissions : {}, scope: 'turn' };
  if (method === 'item/tool/requestUserInput') {
    const result: Record<string, { answers: string[] }> = {};
    for (const q of params.questions ?? []) {
      const answer = answers?.[q.id];
      if (!answer) throw new Error('Responde a todas las preguntas.');
      result[q.id] = { answers: [answer] };
    }
    return { answers: result };
  }
  if (method === 'mcpServer/elicitation/request') return { action: 'decline', content: null };
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
