import type { Message, Session, ToolInfo } from '../src/shared';
const OUTPUT_LIMIT = 30000,
  DIFF_LIMIT = 60000;
// Keep the end of long outputs: failures and summaries are usually printed last.
const tail = (text: string, limit = OUTPUT_LIMIT) =>
  text.length > limit ? '…' + text.slice(text.length - limit) : text;
const json = (value: unknown, limit = OUTPUT_LIMIT) => {
  if (value === undefined || value === null) return '';
  try {
    return (typeof value === 'string' ? value : JSON.stringify(value, null, 2)).slice(0, limit);
  } catch {
    return '';
  }
};
const status = (s: unknown) => (typeof s === 'string' ? s : undefined);
const number = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : undefined);
function tool(id: string, info: ToolInfo, text: string): Message {
  return { id, role: 'tool', text, tool: info };
}
export function messageFromItem(item: any): Message | undefined {
  if (!item || typeof item !== 'object') return;
  if (item.type === 'agentMessage')
    return { id: item.id, role: 'assistant', text: item.text ?? '' };
  if (item.type === 'userMessage')
    return {
      id: item.id,
      role: 'user',
      text: (item.content ?? [])
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n'),
    };
  if (item.type === 'reasoning') {
    const text = [...(item.summary ?? [])].filter(Boolean).join('\n\n');
    return {
      id: item.id,
      role: 'assistant',
      text: '',
      blocks: [{ type: 'thinking', text, final: true }],
    };
  }
  if (item.type === 'commandExecution')
    return tool(
      item.id,
      {
        kind: 'command',
        command: item.command ?? '',
        output: tail(item.aggregatedOutput ?? ''),
        status: status(item.status),
        exitCode: number(item.exitCode),
        durationMs: number(item.durationMs),
        actions: (Array.isArray(item.commandActions) ? item.commandActions : [])
          .slice(0, 40)
          .map((a: any) => ({
            type: String(a?.type ?? 'unknown'),
            path:
              typeof a?.path === 'string'
                ? a.path
                : typeof a?.name === 'string'
                  ? a.name
                  : undefined,
            query: typeof a?.query === 'string' ? a.query : undefined,
          })),
      },
      `$ ${item.command ?? ''}`,
    );
  if (item.type === 'fileChange') {
    const files = (Array.isArray(item.changes) ? item.changes : []).slice(0, 500).map((c: any) => ({
      path: String(c?.path ?? ''),
      kind: String(c?.kind?.type ?? 'update'),
      diff: String(c?.diff ?? '').slice(0, DIFF_LIMIT),
    }));
    return tool(
      item.id,
      { kind: 'edit', status: status(item.status), files },
      `Cambios de archivos · ${files.map((f: { path: string }) => f.path).join(', ')}`,
    );
  }
  if (item.type === 'mcpToolCall')
    return tool(
      item.id,
      {
        kind: 'mcp',
        server: String(item.server ?? ''),
        tool: String(item.tool ?? ''),
        status: status(item.status),
        command: json(item.arguments, 4000),
        output: json(item.error ?? item.result),
        durationMs: number(item.durationMs),
      },
      `${item.server} · ${item.tool}`,
    );
  if (item.type === 'webSearch')
    return tool(
      item.id,
      { kind: 'web', query: String(item.query ?? ''), status: 'completed' },
      `Búsqueda web · ${item.query ?? ''}`,
    );
}
const planStatus: Record<string, string> = {
  pending: 'pending',
  inProgress: 'in_progress',
  completed: 'completed',
};
function lastAssistant(s: Session) {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (m.role === 'user') return;
    if (m.role === 'assistant' && !m.blocks) return m;
  }
}
/** Consume server events without inventing activity or treating terminal text as protocol. */
export function applyCodexEvent(s: Session, method: string, p: any) {
  if (p?.threadId && s.reference && p.threadId !== s.reference) return;
  if (method === 'thread/tokenUsage/updated') {
    if (!s.reference || p?.threadId !== s.reference) return;
    const total = p.tokenUsage?.total;
    if (
      !Number.isSafeInteger(total?.inputTokens) ||
      total.inputTokens < 0 ||
      !Number.isSafeInteger(total?.outputTokens) ||
      total.outputTokens < 0
    )
      return;
    const stats = (s.stats ??= {
      cost: 0,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
    });
    // Provider totals already include cached input and reasoning output. Replace,
    // never add: repeated notifications and thread resumes must not double-count.
    stats.inputTokens = total.inputTokens;
    stats.outputTokens = total.outputTokens;
    stats.tokensReported = true;
  } else if (method === 'model/rerouted') {
    if (s.turnId !== p?.turnId || typeof p.toModel !== 'string') return;
    if (s.optimization) s.optimization.model = p.toModel;
    if (s.info) s.info.model = p.toModel;
  } else if (method === 'turn/started') {
    s.turnId = p.turn.id;
    s.status = 'working';
  } else if (method === 'turn/completed') {
    s.turnId = undefined;
    s.status = 'ready';
    s.approvals = [];
    if (p.turn.error) s.error = p.turn.error.message;
    if (p.turn.status === 'interrupted')
      s.messages.push({
        id: `sys-${p.turn.id}-interrupted`,
        role: 'system',
        kind: 'info',
        text: 'Interrumpido · Escribe qué debe hacer en su lugar.',
        at: Date.now(),
      });
    const started = number(p.turn.startedAt),
      completed = number(p.turn.completedAt);
    const duration =
      number(p.turn.durationMs) ??
      (started !== undefined && completed !== undefined ? (completed - started) * 1000 : undefined);
    const answer = lastAssistant(s);
    if (answer && duration !== undefined && duration > 0) answer.durationMs = duration;
  } else if (method === 'turn/plan/updated') {
    if (!Array.isArray(p?.plan)) return;
    s.todos = p.plan.slice(0, 50).map((step: any) => ({
      content: String(step?.step ?? ''),
      status: planStatus[step?.status] ?? 'pending',
    }));
  } else if (method === 'item/agentMessage/delta') {
    let m = s.messages.find((x) => x.id === p.itemId);
    if (!m) {
      m = { id: p.itemId, role: 'assistant', text: '' };
      s.messages.push(m);
    }
    m.text += p.delta;
  } else if (method === 'item/reasoning/summaryTextDelta') {
    let m = s.messages.find((x) => x.id === p.itemId);
    if (!m) {
      m = { id: p.itemId, role: 'assistant', text: '', blocks: [{ type: 'thinking', text: '' }] };
      s.messages.push(m);
    }
    const block = m.blocks?.[0];
    if (block?.type === 'thinking' && !block.final) block.text += p.delta ?? '';
  } else if (method === 'item/reasoning/summaryPartAdded') {
    const block = s.messages.find((x) => x.id === p.itemId)?.blocks?.[0];
    if (block?.type === 'thinking' && !block.final && block.text.trim()) block.text += '\n\n';
  } else if (method === 'item/started' || method === 'item/completed') {
    const m = messageFromItem(p.item);
    if (m) {
      const previous = s.messages.find((x) => x.id === m.id);
      const thinking = previous?.blocks?.[0];
      const next = m.blocks?.[0];
      if (next?.type === 'thinking') {
        // A reasoning item without summaries keeps the text streamed so far.
        if (!next.text && thinking?.type === 'thinking') next.text = thinking.text;
        next.final = method === 'item/completed';
      }
      if (previous) Object.assign(previous, m);
      else s.messages.push(m);
    }
  } else if (method === 'item/commandExecution/outputDelta') {
    const m = s.messages.find((x) => x.id === p.itemId);
    if (m?.tool) m.tool.output = tail((m.tool.output ?? '') + (p.delta ?? ''));
    else if (m) m.text += p.delta;
  } else if (method === 'serverRequest/resolved') {
    s.approvals = s.approvals.filter((a) => a.id !== p.requestId);
    if (!s.approvals.length && s.turnId) s.status = 'working';
  } else if (method === 'error') s.error = p.error?.message ?? 'Error del servidor.';
}
