import { z } from 'zod';
const target = { tabId: z.string().min(1).max(150).optional() };
const ref = z.string().regex(/^e\d+$/);
const coordinate = z.number().finite().min(0).max(50000);
const pointer = { ref: ref.optional(), x: coordinate.optional(), y: coordinate.optional() };
const pointerTarget = (value: { ref?: string; x?: number; y?: number }) =>
  value.ref
    ? value.x === undefined && value.y === undefined
    : value.x !== undefined && value.y !== undefined;
const keys = [
  'Enter',
  'Tab',
  'Escape',
  'ArrowDown',
  'ArrowUp',
  'ArrowLeft',
  'ArrowRight',
  'Backspace',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Space',
  'a',
  'c',
  'v',
  'x',
  'z',
] as const;
const modifiers = z
  .array(z.enum(['control', 'shift', 'alt', 'meta']))
  .max(4)
  .optional();
export const browserInput = z.discriminatedUnion('action', [
  z.object({ ...target, action: z.literal('navigate'), url: z.string().min(1).max(4096) }).strict(),
  z
    .object({ ...target, action: z.literal('new'), url: z.string().min(1).max(4096).optional() })
    .strict(),
  z.object({ ...target, action: z.literal('zoom'), factor: z.number().min(0.25).max(3) }).strict(),
  ...(
    ['inspect', 'screenshot', 'back', 'forward', 'reload', 'close', 'list', 'suspend'] as const
  ).map((action) => z.object({ ...target, action: z.literal(action) }).strict()),
  z
    .object({
      ...target,
      ...pointer,
      action: z.literal('click'),
      button: z.enum(['left', 'right', 'middle']).optional(),
      clickCount: z.number().int().min(1).max(2).optional(),
    })
    .strict()
    .refine(pointerTarget, 'Use ref or both x and y, never both.'),
  z
    .object({ ...target, ...pointer, action: z.literal('hover') })
    .strict()
    .refine(pointerTarget, 'Use ref or both x and y, never both.'),
  z.object({ ...target, action: z.literal('move'), x: coordinate, y: coordinate }).strict(),
  z.object({ ...target, action: z.literal('select'), ref, value: z.string().max(20000) }).strict(),
  z.object({ ...target, action: z.literal('check'), ref, checked: z.boolean() }).strict(),
  z
    .object({
      ...target,
      action: z.literal('upload'),
      ref,
      paths: z.array(z.string().min(1).max(4096)).max(20),
    })
    .strict(),
  z
    .object({
      ...target,
      ...pointer,
      action: z.literal('drag'),
      toRef: ref.optional(),
      toX: coordinate.optional(),
      toY: coordinate.optional(),
    })
    .strict()
    .refine(pointerTarget, 'Use ref or both x and y for the drag source.')
    .refine(
      (value) => pointerTarget({ ref: value.toRef, x: value.toX, y: value.toY }),
      'Use toRef or both toX and toY for the drag destination.',
    ),
  z.object({ ...target, action: z.literal('download'), url: z.string().min(1).max(8192) }).strict(),
  z.object({ ...target, action: z.literal('downloads') }).strict(),
  z
    .object({
      ...target,
      action: z.literal('downloadControl'),
      downloadId: z.string().min(1).max(150),
      operation: z.enum(['pause', 'resume', 'cancel']),
    })
    .strict(),
  z
    .object({
      ...target,
      action: z.literal('dialog'),
      dialogId: z.string().min(1).max(150),
      accept: z.boolean(),
      promptText: z.string().max(20000).optional(),
    })
    .strict(),
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
      key: z.enum(keys),
      modifiers,
    })
    .strict(),
  z
    .object({
      ...target,
      action: z.literal('scroll'),
      deltaY: z.number().int().min(-5000).max(5000),
      deltaX: z.number().int().min(-5000).max(5000).optional(),
      ref: ref.optional(),
    })
    .strict(),
]);
export type BrowserInput = z.infer<typeof browserInput>;
export interface BrowserState {
  id: string;
  backend?: 'integrated' | 'chrome';
  connectionId?: string;
  projectId?: string;
  zoom: number;
  suspended?: boolean;
  hostStatus?: 'online' | 'offline';
  sessionId: string;
  url: string;
  externalUrl?: string;
  title: string;
  loading: boolean;
  error?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  downloads?: import('./browser-downloads').BrowserDownload[];
  dialog?: import('./browser-dialogs').BrowserDialog;
  permissions?: import('./browser-permissions').BrowserPermission[];
  activity?: {
    action: string;
    phase: 'running' | 'done' | 'error';
    at: number;
    label?: string;
    sessionId?: string;
    error?: string;
  };
}
export {
  browserURL,
  browserPartition,
  isAuthenticationURL,
  externalBrowserURL,
} from './browser-urls';

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
    'hover',
    'move',
    'select',
    'check',
    'drag',
    'upload',
    'download',
    'downloads',
    'downloadControl',
    'dialog',
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
  key: z.enum(keys).optional(),
  modifiers,
  x: coordinate.optional(),
  y: coordinate.optional(),
  button: z.enum(['left', 'right', 'middle']).optional(),
  clickCount: z.number().int().min(1).max(2).optional(),
  value: z.string().max(20000).optional(),
  checked: z.boolean().optional(),
  paths: z.array(z.string().min(1).max(4096)).max(20).optional(),
  toRef: ref.optional(),
  toX: coordinate.optional(),
  toY: coordinate.optional(),
  downloadId: z.string().min(1).max(150).optional(),
  operation: z.enum(['pause', 'resume', 'cancel']).optional(),
  dialogId: z.string().min(1).max(150).optional(),
  accept: z.boolean().optional(),
  promptText: z.string().max(20000).optional(),
  deltaX: z.number().int().min(-5000).max(5000).optional(),
  deltaY: z.number().int().min(-5000).max(5000).optional(),
};
