import { z } from 'zod';
import { MIN_FLOATING_OPACITY } from './floating-chat-state';
export { MIN_FLOATING_OPACITY, floatingChatHash, floatingChatId } from './floating-chat-state';
export type { FloatingChatState } from './floating-chat-state';

export const floatingChatAction = z
  .object({
    type: z.literal('floatingChat'),
    sessionId: z.string().min(1).max(150),
    operation: z.enum(['open', 'focus', 'dock', 'close', 'configure']),
    opacity: z.number().min(MIN_FLOATING_OPACITY).max(1).optional(),
    alwaysOnTop: z.boolean().optional(),
    glass: z.boolean().optional(),
    blur: z.boolean().optional(),
    glassStrength: z.number().min(0).max(2).optional(),
  })
  .strict();

export type FloatingChatAction = z.infer<typeof floatingChatAction>;
