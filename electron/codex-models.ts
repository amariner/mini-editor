import { z } from 'zod';
import type { CodexConfig, ModelInfo } from '../src/shared';
const pageSchema = z.object({
  data: z.array(
    z.object({
      model: z.string().min(1),
      displayName: z.string().optional(),
      description: z.string().optional(),
      hidden: z.boolean().optional(),
      isDefault: z.boolean().optional(),
      defaultReasoningEffort: z.string().optional(),
      supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })).optional(),
    }),
  ),
  nextCursor: z.string().nullable().optional(),
});
export async function fetchCodexModels(
  call: (method: string, params: unknown) => Promise<unknown>,
): Promise<ModelInfo[]> {
  const models = new Map<string, ModelInfo>(),
    cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = pageSchema.parse(
      await call('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }),
    );
    for (const m of page.data)
      if (!m.hidden)
        models.set(m.model, {
          value: m.model,
          displayName: m.displayName ?? m.model,
          description: m.description ?? '',
          isDefault: m.isDefault,
          defaultEffort: m.defaultReasoningEffort,
          supportedEffortLevels: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort),
        });
    cursor = page.nextCursor ?? undefined;
    if (cursor) {
      if (cursors.has(cursor) || cursors.size >= 100)
        throw new Error('El servidor no ha completado la lista de modelos.');
      cursors.add(cursor);
    }
  } while (cursor);
  return [...models.values()];
}
export function selectCodexConfig(
  before: CodexConfig,
  patch: Partial<CodexConfig>,
  models: ModelInfo[],
): CodexConfig {
  const next = { ...before, ...patch };
  const selected = models.find((m) =>
    next.model === 'default' ? m.isDefault : m.value === next.model,
  );
  if (patch.model !== undefined && patch.model !== 'default' && !selected)
    throw new Error(
      'Ese modelo no está en el catálogo de Codex. Actualiza la lista antes de seleccionarlo.',
    );
  if (patch.effort && !selected?.supportedEffortLevels?.includes(patch.effort))
    throw new Error('Este modelo no admite ese esfuerzo de razonamiento.');
  if (patch.model !== undefined && patch.model !== before.model && patch.effort === undefined)
    next.effort = undefined;
  if (next.effort && selected && !selected.supportedEffortLevels?.includes(next.effort))
    next.effort = undefined;
  return next;
}
/** Explicit values reset a resumed thread too; omission would inherit its previous model/effort. */
export function resolveCodexModel(config: CodexConfig, models: ModelInfo[]): CodexConfig {
  const model = models.find((m) =>
    config.model === 'default' ? m.isDefault : m.value === config.model,
  );
  return {
    ...config,
    model: model?.value ?? config.model,
    effort: config.effort ?? model?.defaultEffort,
  };
}
