import { z } from 'zod';

export const MIN_FLOATING_OPACITY = 0.1;
export const floatingChatAction = z
  .object({
    type: z.literal('floatingChat'),
    sessionId: z.string().min(1).max(150),
    operation: z.enum(['open', 'focus', 'dock', 'close', 'configure']),
    opacity: z.number().min(MIN_FLOATING_OPACITY).max(1).optional(),
    alwaysOnTop: z.boolean().optional(),
  })
  .strict();

export type FloatingChatAction = z.infer<typeof floatingChatAction>;
export interface FloatingChatState {
  sessionId: string;
  opacity: number;
  alwaysOnTop: boolean;
}

export const floatingChatHash = (id: string) => `#chat=${encodeURIComponent(id)}`;
export function floatingChatId(hash: string) {
  if (!hash.startsWith('#chat=')) return undefined;
  try {
    const id = decodeURIComponent(hash.slice(6));
    return id && id.length <= 150 ? id : undefined;
  } catch {
    return undefined;
  }
}
