import { z } from 'zod';
export const teamToolFields = {
  operation: z.enum(['list', 'spawn', 'link', 'read', 'send']),
  targetId: z.string().min(1).max(200).optional(),
  projectId: z.string().min(1).max(200).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  text: z.string().trim().min(1).max(20000).optional(),
};
export const teamInput = z.object(teamToolFields).strict();
export type TeamInput = z.infer<typeof teamInput>;
export type TeamMessage = {
  id: string;
  from: string;
  text: string;
  at: number;
  status: 'queued' | 'sending' | 'delivered' | 'failed';
  error?: string;
};
