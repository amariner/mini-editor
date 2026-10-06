import { z } from 'zod';
const target = { tabId: z.string().min(1).max(150).optional() };
export const browserInput = z.discriminatedUnion('action', [
  z.object({ ...target, action: z.literal('navigate'), url: z.string().min(1).max(4096) }).strict(),
  z
    .object({ ...target, action: z.literal('new'), url: z.string().min(1).max(4096).optional() })
    .strict(),
  z.object({ ...target, action: z.literal('zoom'), factor: z.number().min(0.25).max(3) }).strict(),
  ...(
    ['inspect', 'screenshot', 'back', 'forward', 'reload', 'close', 'list', 'suspend'] as const
  ).map((action) => z.object({ ...target, action: z.literal(action) }).strict()),
  z.object({ ...target, action: z.literal('click'), ref: z.string().regex(/^e\d+$/) }).strict(),
  z
    .object({
      ...target,
      action: z.literal('fill'),
      ref: z.string().regex(/^e\d+$/),
      text: z.string().max(20000),
    })
    .strict(),
  z
    .object({
      ...target,
      action: z.literal('press'),
      key: z.enum([
        'Enter',
        'Tab',
        'Escape',
        'ArrowDown',
        'ArrowUp',
        'ArrowLeft',
        'ArrowRight',
        'Backspace',
      ]),
    })
    .strict(),
  z
    .object({
      ...target,
      action: z.literal('scroll'),
      deltaY: z.number().int().min(-5000).max(5000),
    })
    .strict(),
]);
export type BrowserInput = z.infer<typeof browserInput>;
export interface BrowserState {
  id: string;
  projectId?: string;
  zoom: number;
  suspended?: boolean;
  hostStatus?: 'online' | 'offline';
  sessionId: string;
  url: string;
  title: string;
  loading: boolean;
  error?: string;
  canGoBack: boolean;
  canGoForward: boolean;
}
export function browserURL(value: string): string {
  const text = value.trim();
  const url = new URL(
    /^[a-z][a-z\d+.-]*:\/\//i.test(text) || /^(about|file|data|javascript):/i.test(text)
      ? text
      : `http://${text}`,
  );
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Usa una dirección http:// o https:// sin credenciales en la URL.');
  return url.href;
}

// MCP requires a top-level object schema; the main process enforces the stricter union above.
export const browserToolFields = {
  action: z.enum([
    'navigate',
    'new',
    'list',
    'zoom',
    'suspend',
    'inspect',
    'screenshot',
    'back',
    'forward',
    'reload',
    'close',
    'click',
    'fill',
    'press',
    'scroll',
  ]),
  tabId: z.string().min(1).max(150).optional(),
  factor: z.number().min(0.25).max(3).optional(),
  url: z.string().max(4096).optional(),
  ref: z
    .string()
    .regex(/^e\d+$/)
    .optional(),
  text: z.string().max(20000).optional(),
  key: z
    .enum([
      'Enter',
      'Tab',
      'Escape',
      'ArrowDown',
      'ArrowUp',
      'ArrowLeft',
      'ArrowRight',
      'Backspace',
    ])
    .optional(),
  deltaY: z.number().int().min(-5000).max(5000).optional(),
};
