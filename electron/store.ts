import { isCodex, legacyProfiles } from '../src/shared';
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
  optimizationSchema,
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
  command: z.string().max(20000).optional(),
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
  defaultProfile: profileSchema.optional(),
  removedProfiles: z.array(profileSchema).optional(),
  profiles: z
    .array(
      z.object({
        id: profileSchema,
        name: z.string().trim().min(1).max(40),
        kind: z.enum(['claude', 'codex']),
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
      reference: z.string().optional(),
      attempted: z.boolean().optional(),
      accountLocked: z.boolean().optional(),
      mode: z.enum(['chat', 'terminal']).optional(),
      config: claudeConfigSchema.partial().optional(),
      codexConfig: codexConfigSchema.partial().optional(),
      stats: z
        .object({
          tokensReported: z.boolean().optional(),
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
                preview: z.string().startsWith('data:image/').max(2000000),
              }),
            )
            .max(4)
            .optional(),
          blocks: z.array(block).optional(),
          kind: z.enum(['result', 'compact', 'info', 'error', 'command', 'warning']).optional(),
          model: z.string().optional(),
          at: z.number().optional(),
          durationMs: z.number().optional(),
          tool: toolInfo.optional(),
        }),
      ),
    }),
  ),
  selectedProject: z.string().optional(),
  selectedSession: z.string().optional(),
  tools: z.object({ claude: z.string().optional(), codex: z.string().optional() }),
});
export class Store {
  state: Snapshot;
  private timer?: NodeJS.Timeout;
  constructor(readonly root: string) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.state = {
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
          definitions.some((p) => (isCodex(p.id) ? 'codex' : 'claude') !== p.kind) ||
          data.sessions.some((s) => !definitions.some((p) => p.id === s.profile))
        )
          throw new Error('Perfiles no válidos.');
        this.state = {
          ...this.state,
          ...data,
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
            messages: s.messages.map((m) => ({
              ...m,
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
          stats,
          messages: messages.map(
            ({ id, role, text, attachments, blocks, kind, model, at, durationMs, tool }) => ({
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
