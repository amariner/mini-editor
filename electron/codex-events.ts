import type { Message, Session } from '../src/shared';
export function messageFromItem(item: any): Message | undefined {
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
  if (item.type === 'mcpToolCall')
    return {
      id: item.id,
      role: 'tool',
      text: `${item.server} · ${item.tool} · ${item.status}\n${JSON.stringify(item.arguments ?? {})}\n${item.result ? JSON.stringify(item.result).slice(0, 20000) : ''}${item.error ? JSON.stringify(item.error) : ''}`,
    };
  if (item.type === 'commandExecution')
    return {
      id: item.id,
      role: 'tool',
      text: `$ ${item.command ?? ''}\n${item.aggregatedOutput ?? ''}\n${item.status ?? ''}`,
    };
  if (item.type === 'fileChange')
    return {
      id: item.id,
      role: 'tool',
      text: `Cambios de archivos · ${item.status}\n${(item.changes ?? []).map((c: any) => `${c.path}\n${c.diff ?? ''}`).join('\n')}`,
    };
}
/** Consume server events without inventing activity or treating terminal text as protocol. */
export function applyCodexEvent(s: Session, method: string, p: any) {
  if (p?.threadId && s.reference && p.threadId !== s.reference) return;
  if (method === 'turn/started') {
    s.turnId = p.turn.id;
    s.status = 'working';
  } else if (method === 'turn/completed') {
    s.turnId = undefined;
    s.status = 'ready';
    s.approvals = [];
    if (p.turn.error) s.error = p.turn.error.message;
  } else if (method === 'item/agentMessage/delta') {
    let m = s.messages.find((x) => x.id === p.itemId);
    if (!m) {
      m = { id: p.itemId, role: 'assistant', text: '' };
      s.messages.push(m);
    }
    m.text += p.delta;
  } else if (method === 'item/started' || method === 'item/completed') {
    const m = messageFromItem(p.item);
    if (m) {
      const previous = s.messages.find((x) => x.id === m.id);
      if (previous) Object.assign(previous, m);
      else s.messages.push(m);
    }
  } else if (method === 'item/commandExecution/outputDelta') {
    const m = s.messages.find((x) => x.id === p.itemId);
    if (m) m.text += p.delta;
  } else if (method === 'serverRequest/resolved') {
    s.approvals = s.approvals.filter((a) => a.id !== p.requestId);
    if (!s.approvals.length && s.turnId) s.status = 'working';
  } else if (method === 'error') s.error = p.error?.message ?? 'Error del servidor.';
}
