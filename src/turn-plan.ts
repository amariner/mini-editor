import type { Block, Message, Session } from './shared';

export type PlanItem = NonNullable<Session['todos']>[number];

const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate']);
const STATUSES = new Set(['pending', 'in_progress', 'completed']);

function* rootTools(messages: Message[]) {
  for (const m of messages)
    for (const b of m.blocks ?? [])
      if (b.type === 'tool_use') yield b as Extract<Block, { type: 'tool_use' }>;
}

/** Did this turn publish or update a task list? */
export function hasPlanTools(messages: Message[]) {
  for (const b of rootTools(messages)) if (PLAN_TOOLS.has(b.name)) return true;
  return false;
}

function createdId(result?: string) {
  if (!result) return '';
  try {
    const parsed = JSON.parse(result);
    const id = parsed?.task?.id ?? parsed?.taskId ?? parsed?.id;
    if (id !== undefined) return String(id);
  } catch {
    /* The CLI also answers in plain text. */
  }
  return /Task #([^\s]+) created/.exec(result)?.[1] ?? '';
}

/**
 * The task list as it stood at the end of a turn, replayed from its own tool calls
 * (TodoWrite replaces the list; TaskCreate/TaskUpdate edit it). Undefined without a plan.
 */
export function turnPlan(messages: Message[]): PlanItem[] | undefined {
  let plan: PlanItem[] | undefined;
  for (const b of rootTools(messages)) {
    if (b.isError) continue;
    const input = (b.input ?? {}) as Record<string, any>;
    if (b.name === 'TodoWrite' && Array.isArray(input.todos)) {
      plan = input.todos
        .filter((t: any) => typeof t?.content === 'string' && t.content.trim())
        .slice(0, 100)
        .map((t: any) => ({
          content: t.content,
          status: STATUSES.has(t.status) ? t.status : 'pending',
          activeForm: typeof t.activeForm === 'string' ? t.activeForm : undefined,
        }));
    } else if (b.name === 'TaskCreate' && typeof input.subject === 'string') {
      plan = [
        ...(plan ?? []),
        {
          id: createdId(b.result) || undefined,
          content: input.subject,
          activeForm: typeof input.activeForm === 'string' ? input.activeForm : undefined,
          status: 'pending',
        },
      ];
    } else if (b.name === 'TaskUpdate' && input.taskId !== undefined && plan) {
      const id = String(input.taskId);
      if (input.status === 'deleted') {
        plan = plan.filter((t) => t.id !== id);
        continue;
      }
      plan = plan.map((t) =>
        t.id !== id
          ? t
          : {
              ...t,
              status: STATUSES.has(input.status) ? input.status : t.status,
              content: typeof input.subject === 'string' ? input.subject : t.content,
              activeForm: typeof input.activeForm === 'string' ? input.activeForm : t.activeForm,
            },
      );
    }
  }
  return plan?.length ? plan : undefined;
}
