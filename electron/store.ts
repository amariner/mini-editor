import { isCodex, isConnectedProvider, providerKind, legacyProfiles } from '../src/shared';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Snapshot } from '../src/shared';
import { sessionAccountLocked } from '../src/session-tabs';
import {
  claudeConfigSchema,
  codexConfigSchema,
  mergeCodexConfig,
  mergeConfig,
  profileSchema,
  modelSelectionSchema,
  providerConfigSchema,
  optimizationSchema,
  accountColorSchema,
} from './core';
const block: z.ZodType<any> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string(), final: z.boolean().optional() }),
    z.object({ type: z.literal('thinking'), text: z.string(), final: z.boolean().optional() }),
    z.object({
      type: z.literal('tool_use'),
      id: z.string(),
      name: z.string(),
      input: z.any(),
      final: z.boolean().optional(),
      result: z.string().optional(),
      isError: z.boolean().optional(),
      done: z.boolean().optional(),
      elapsed: z.number().optional(),
      ms: z.number().optional(),
      children: z.array(block).optional(),
    }),
  ]),
);
const toolInfo = z.object({
  kind: z.enum(['command', 'edit', 'mcp', 'web']),
  status: z.string().max(40).optional(),
  // Persisted commands may contain large scripts or patches emitted by providers.
  command: z.string().optional(),
  output: z.string().max(40000).optional(),
  exitCode: z.number().optional(),
  durationMs: z.number().optional(),
  actions: z
    .array(
      z.object({
        type: z.string().max(40),
        path: z.string().max(4096).optional(),
        query: z.string().max(4096).optional(),
      }),
    )
    .max(40)
    .optional(),
  files: z
    .array(z.object({ path: z.string().max(4096), kind: z.string().max(40), diff: z.string() }))
    .max(500)
    .optional(),
  server: z.string().max(200).optional(),
  tool: z.string().max(200).optional(),
  query: z.string().max(4096).optional(),
});
const schema = z.object({
  freebuffEnabled: z.boolean().optional(),
  defaultProfile: profileSchema.optional(),
  removedProfiles: z.array(profileSchema).optional(),
  profiles: z
    .array(
      z.object({
        id: profileSchema,
        name: z.string().trim().min(1).max(40),
        kind: z.enum(['claude', 'codex', 'openrouter', 'opencode', 'gemini']),
        color: accountColorSchema.optional(),
        modelSelection: modelSelectionSchema.optional(),
        googleCloudProject: z.string().max(100).optional(),
        optimization: optimizationSchema.optional(),
      }),
    )
    .max(100)
    .optional(),
  projects: z.array(z.object({ id: z.string(), name: z.string(), path: z.string() })),
  sessions: z.array(
    z.object({
      id: z.string(),
      projectId: z.string(),
      profile: profileSchema,
      title: z.string(),
      pendingInputs: z
        .array(
          z.object({
            id: z.string(),
            text: z.string(),
            attachments: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                mediaType: z.string().optional(),
                size: z.number().optional(),
                preview: z.string().optional(),
              }),
            ),
            status: z.enum(['pending', 'sending', 'failed']),
            error: z.string().optional(),
          }),
        )
        .optional(),
      parentId: z.string().optional(),
      teamMessages: z
        .array(
          z.object({
            id: z.string(),
            from: z.string(),
            text: z.string(),
            at: z.number(),
            status: z.enum(['queued', 'sending', 'delivered', 'failed']),
            error: z.string().optional(),
          }),
        )
        .optional(),
      reference: z.string().optional(),
      attempted: z.boolean().optional(),
      accountLocked: z.boolean().optional(),
      mode: z.enum(['chat', 'terminal']).optional(),
      config: claudeConfigSchema.partial().optional(),
      codexConfig: codexConfigSchema.partial().optional(),
      providerConfig: providerConfigSchema.optional(),
      isolation: z.enum(['worktree', 'shared']).optional(),
      worktree: z
        .object({
          path: z.string(),
          cwd: z.string(),
          branch: z.string(),
          base: z.string(),
          baseCommit: z.string(),
          root: z.string(),
          createdAt: z.number(),
        })
        .optional(),
      forkFrom: z.string().optional(),
      forkOf: z.string().optional(),
      stats: z
        .object({
          tokensReported: z.boolean().optional(),
          costReported: z.boolean().optional(),
          costEstimated: z.boolean().optional(),
          cost: z.number(),
          turns: z.number(),
          inputTokens: z.number(),
          outputTokens: z.number(),
          durationMs: z.number(),
          contextTokens: z.number().optional(),
          contextMax: z.number().optional(),
          contextPercent: z.number().optional(),
        })
        .optional(),
      messages: z.array(
        z.object({
          id: z.string(),
          role: z.enum(['user', 'assistant', 'tool', 'system']),
          text: z.string(),
          attachments: z
            .array(
              z.object({
                id: z.string(),
                name: z.string(),
                preview: z.string().startsWith('data:image/').max(2000000).optional(),
                mediaType: z.string().optional(),
                size: z.number().nonnegative().optional(),
              }),
            )

            .optional(),
          blocks: z.array(block).optional(),
          kind: z.enum(['result', 'compact', 'info', 'error', 'command', 'warning']).optional(),
          model: z.string().optional(),
          at: z.number().optional(),
          durationMs: z.number().optional(),
          tool: toolInfo.optional(),
          checkpoint: z.string().optional(),
        }),
      ),
    }),
  ),
  selectedProject: z.string().optional(),
  selectedSession: z.string().optional(),
  tools: z.object({
    claude: z.string().optional(),
    codex: z.string().optional(),
    gemini: z.string().optional(),
    freebuff: z.string().optional(),
  }),
});
export class Store {
  state: Snapshot;
  private timer?: NodeJS.Timeout;
  constructor(readonly root: string) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.state = {
      freebuffEnabled: false,
      profiles: [],
      projects: [],
      sessions: [],
      tools: {},
      dataDir: root,
    };
    const file = path.join(root, 'state.json');
    if (fs.existsSync(file))
      try {
        const data = schema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
        const definitions = data.profiles ?? legacyProfiles.map((p) => ({ ...p }));
        if (
          new Set(definitions.map((p) => p.id)).size !== definitions.length ||
          definitions.some((p) => providerKind(p.id) !== p.kind) ||
          data.sessions.some((s) => !definitions.some((p) => p.id === s.profile))
        )
          throw new Error('Perfiles no válidos.');
        this.state = {
          ...this.state,
          ...data,
          freebuffEnabled: data.freebuffEnabled ?? !!data.tools.freebuff,
          profiles: definitions,
          defaultProfile: definitions.some((p) => p.id === data.defaultProfile)
            ? data.defaultProfile
            : definitions[0]?.id,
          sessions: data.sessions.map((s) => ({
            ...s,
            accountLocked: sessionAccountLocked(s),
            config: s.config ? mergeConfig(s.config) : undefined,
            codexConfig: isCodex(s.profile) ? mergeCodexConfig(s.codexConfig) : undefined,
            status: 'stopped',
            approvals: [],
            subagents: undefined,
            pendingInputs: s.pendingInputs?.map((p) => ({
              ...p,
              status: 'failed' as const,
              error:
                'Envío pendiente al cerrar la aplicación. Recupera el texto y vuelve a adjuntar los archivos si los había.',
            })),
            teamMessages: s.teamMessages?.map((m) =>
              m.status === 'queued' || m.status === 'sending'
                ? {
                    ...m,
                    status: 'failed' as const,
                    error:
                      'Envío interrumpido al cerrar la aplicación. Vuelve a enviarlo si sigue siendo necesario.',
                  }
                : m,
            ),
            messages: s.messages.map((m) => ({
              ...m,
              tool: m.tool?.status === 'inProgress' ? { ...m.tool, status: 'failed' } : m.tool,
              blocks: m.blocks?.map((b: any) =>
                b.type === 'tool_use' ? { ...b, done: true, final: true } : { ...b, final: true },
              ),
            })),
          })),
        };
      } catch {
        throw new Error(
          'El archivo local state.json no es válido. Se ha conservado sin sobrescribirlo.',
        );
      }
  }
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 250);
  }
  flush() {
    clearTimeout(this.timer);
    const { dataDir, notice, ...data } = this.state;
    const safe = {
      ...data,
      sessions: data.sessions.map(
        ({
          id,
          projectId,
          profile,
          title,
          reference,
          attempted,
          accountLocked,
          mode,
          config,
          codexConfig,
          providerConfig,
          isolation,
          worktree,
          forkFrom,
          forkOf,
          pendingInputs,
          parentId,
          teamMessages,
          stats,
          messages,
        }) => ({
          id,
          projectId,
          profile,
          title,
          reference,
          attempted,
          accountLocked,
          mode,
          config,
          codexConfig,
          providerConfig,
          isolation,
          worktree,
          forkFrom,
          forkOf,
          pendingInputs,
          parentId,
          teamMessages,
          stats,
          messages: messages.map(
            ({
              id,
              role,
              text,
              attachments,
              blocks,
              kind,
              model,
              at,
              durationMs,
              tool,
              checkpoint,
            }) => ({
              id,
              role,
              text,
              attachments,
              blocks: blocks?.map((b) =>
                b.type === 'tool_use'
                  ? {
                      type: b.type,
                      id: b.id,
                      name: b.name,
                      input: b.input,
                      result: b.result,
                      isError: b.isError,
                      ms: b.ms,
                      children: b.children,
                    }
                  : { type: b.type, text: b.text },
              ),
              kind,
              model,
              at,
              durationMs,
              tool,
              checkpoint,
            }),
          ),
        }),
      ),
    };
    const file = path.join(this.root, 'state.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(safe), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }
}
