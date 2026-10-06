import type { Block, Message, Session } from '../src/shared';
const RESULT_LIMIT = 30000,
  MESSAGE_LIMIT = 400;
function contentText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((c) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[imagen]' : ''))
      .filter(Boolean)
      .join('\n');
  return content == null ? '' : JSON.stringify(content);
}
function* walk(blocks: Block[] | undefined): Generator<Block> {
  for (const b of blocks ?? []) {
    yield b;
    if (b.type === 'tool_use' && b.children) yield* walk(b.children);
  }
}
export function findTool(s: Session, id: string) {
  for (let i = s.messages.length - 1; i >= 0; i--)
    for (const b of walk(s.messages[i].blocks)) if (b.type === 'tool_use' && b.id === id) return b;
}
function lastAssistant(s: Session, id?: string) {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (m.role === 'assistant' && m.blocks && (!id || m.id === id)) return m;
  }
}
function assistantMessage(s: Session, id: string, model?: string) {
  let m = lastAssistant(s, id);
  if (!m) {
    m = { id, role: 'assistant', text: '', blocks: [], model, at: Date.now() };
    push(s, m);
  }
  return m;
}
function push(s: Session, m: Message) {
  s.messages.push(m);
  if (s.messages.length > MESSAGE_LIMIT) s.messages.splice(0, s.messages.length - MESSAGE_LIMIT);
}
/** Mark every tool still running as finished (after an interruption or exit). */
export function settle(s: Session) {
  for (const m of s.messages)
    for (const b of walk(m.blocks)) if (b.type === 'tool_use' && !b.done) b.done = true;
}
export function note(s: Session, kind: Message['kind'], text: string) {
  push(s, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    role: 'system',
    text,
    kind,
    at: Date.now(),
  });
}
function finalize(s: Session, blocks: Block[], content: any[], streamed: boolean) {
  for (const c of content ?? []) {
    if (c.type === 'tool_use') {
      const existing = blocks.find((b) => b.type === 'tool_use' && b.id === c.id);
      if (existing && existing.type === 'tool_use') {
        existing.input = c.input;
        existing.final = true;
        existing.partial = undefined;
      } else blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input, final: true });
      if (c.name === 'TodoWrite' && Array.isArray(c.input?.todos)) s.todos = c.input.todos;
    } else if (c.type === 'text' || c.type === 'thinking') {
      const text = c.type === 'text' ? c.text : c.thinking;
      const open = streamed
        ? blocks.find((b) => b.type === c.type && !b.final && b.type !== 'tool_use')
        : undefined;
      if (open && open.type !== 'tool_use') {
        open.text = text ?? open.text;
        open.final = true;
      } else blocks.push({ type: c.type, text: text ?? '', final: true });
    } else if (c.type === 'redacted_thinking')
      blocks.push({ type: 'thinking', text: '', final: true });
  }
}
const errorText: Record<string, string> = {
  authentication_failed:
    'La cuenta de este perfil no está conectada. Abre la terminal y usa /login.',
  oauth_org_not_allowed: 'Tu organización no permite este inicio de sesión.',
  account_on_hold: 'La cuenta está en pausa.',
  billing_error: 'Problema de facturación en la cuenta.',
  rate_limit: 'Límite de uso alcanzado. Espera a que se restablezca.',
  overloaded: 'El servicio está saturado. Vuelve a intentarlo.',
  model_not_found: 'El modelo seleccionado no está disponible para esta cuenta.',
  server_error: 'Error del servidor de Anthropic.',
  max_output_tokens: 'La respuesta superó la longitud máxima.',
};
/** Fold one Agent SDK message into the session. Pure: no process or UI knowledge. */
export function applyClaudeMessage(s: Session, m: any) {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'stream_event') {
    if (m.parent_tool_use_id) return;
    const e = m.event;
    if (e.type === 'message_start') {
      assistantMessage(s, e.message.id, e.message.model);
      return;
    }
    const msg = lastAssistant(s);
    if (!msg) return;
    const blocks = msg.blocks!;
    if (e.type === 'content_block_start') {
      const c = e.content_block;
      if (blocks[e.index]) return;
      blocks[e.index] =
        c.type === 'tool_use'
          ? { type: 'tool_use', id: c.id, name: c.name, input: c.input ?? {}, partial: '' }
          : {
              type: c.type === 'thinking' || c.type === 'redacted_thinking' ? 'thinking' : 'text',
              text: c.text ?? c.thinking ?? '',
            };
    } else if (e.type === 'content_block_delta') {
      const b = blocks[e.index];
      if (!b || b.final) return;
      const d = e.delta;
      if (d.type === 'text_delta' && b.type === 'text') b.text += d.text;
      else if (d.type === 'thinking_delta' && b.type === 'thinking') b.text += d.thinking ?? '';
      else if (d.type === 'input_json_delta' && b.type === 'tool_use') {
        b.partial = (b.partial ?? '') + d.partial_json;
        if (b.partial.length < 20000)
          try {
            b.input = JSON.parse(b.partial);
          } catch {
            /* still streaming */
          }
      }
    }
    return;
  }
  if (m.type === 'assistant') {
    const content = m.message?.content ?? [];
    if (m.parent_tool_use_id) {
      const parent = findTool(s, m.parent_tool_use_id);
      if (parent && parent.type === 'tool_use')
        finalize(s, (parent.children ??= []), content, false);
    } else {
      const msg = assistantMessage(s, m.message.id, m.message.model);
      msg.model = m.message.model ?? msg.model;
      finalize(s, msg.blocks!, content, true);
    }
    if (m.error) {
      s.error = errorText[m.error] ?? `Error de la API: ${m.error}`;
      if (m.error === 'authentication_failed') s.account = undefined;
    }
    return;
  }
  if (m.type === 'user') {
    if (m.isReplay) return;
    const content = m.message?.content;
    if (!Array.isArray(content)) return;
    for (const c of content)
      if (c.type === 'tool_result') {
        const b = findTool(s, c.tool_use_id);
        if (b && b.type === 'tool_use') {
          b.result = contentText(c.content).slice(0, RESULT_LIMIT);
          b.isError = !!c.is_error;
          b.done = true;
        }
      }
    return;
  }
  if (m.type === 'result') {
    s.attempted = true;
    const st = (s.stats ??= { cost: 0, turns: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 });
    st.cost = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : st.cost;
    st.turns += 1;
    st.inputTokens +=
      (m.usage?.input_tokens ?? 0) +
      (m.usage?.cache_creation_input_tokens ?? 0) +
      (m.usage?.cache_read_input_tokens ?? 0);
    st.outputTokens += m.usage?.output_tokens ?? 0;
    st.durationMs += m.duration_ms ?? 0;
    for (const b of walk(lastAssistant(s)?.blocks))
      if (b.type === 'tool_use' && !b.done) b.done = true;
    if (m.is_error || m.subtype !== 'success') {
      const reasons: Record<string, string> = {
        error_max_turns: 'Se alcanzó el máximo de turnos configurado.',
        error_max_budget_usd: 'Se alcanzó el presupuesto máximo configurado.',
        error_during_execution: 'Error durante la ejecución.',
      };
      const detail = (m.errors ?? []).join(' ').trim();
      note(
        s,
        'error',
        `${reasons[m.subtype] ?? 'La respuesta terminó con error.'}${detail ? ` ${detail}` : ''}`,
      );
    }
    s.activity = undefined;
    if (!s.approvals.length) s.status = 'ready';
    return;
  }
  if (m.type === 'system') {
    const sub = m.subtype;
    if (sub === 'init') {
      const info = (s.info ??= {
        tools: [],
        commands: [],
        models: [],
        mcpServers: [],
        skills: [],
        plugins: [],
        agents: [],
        outputStyles: [],
      });
      info.version = m.claude_code_version;
      info.model = m.model;
      info.tools = m.tools ?? [];
      info.mcpServers = (m.mcp_servers ?? []).map((x: any) => ({ name: x.name, status: x.status }));
      info.skills = m.skills ?? [];
      info.plugins = (m.plugins ?? []).map((p: any) => p.name);
      info.agents = m.agents ?? [];
      info.outputStyle = m.output_style;
      info.permissionMode = m.permissionMode;
      info.effort = m.effort ?? null;
      info.apiKeySource = m.apiKeySource;
      if (!info.commands.length && Array.isArray(m.slash_commands))
        info.commands = m.slash_commands.map((name: string) => ({ name, description: '' }));
      if (m.session_id) s.reference = m.session_id;
    } else if (sub === 'commands_changed') {
      if (s.info)
        s.info.commands = (m.commands ?? []).map((c: any) => ({
          name: c.name,
          description: c.description ?? '',
          argumentHint: c.argumentHint,
          builtin: c.builtin,
        }));
    } else if (sub === 'status') {
      s.activity =
        m.status === 'compacting'
          ? 'Compactando el contexto…'
          : m.status === 'requesting'
            ? 'Pensando…'
            : undefined;
      if (m.permissionMode && s.info) s.info.permissionMode = m.permissionMode;
      if (m.compact_result === 'failed')
        note(s, 'warning', `No se pudo compactar: ${m.compact_error ?? ''}`);
    } else if (sub === 'compact_boundary') {
      const c = m.compact_metadata ?? {};
      note(
        s,
        'compact',
        `Contexto compactado (${c.trigger === 'auto' ? 'automático' : 'manual'})${c.pre_tokens ? ` · ${Math.round(c.pre_tokens / 1000)}k → ${Math.round((c.post_tokens ?? 0) / 1000)}k tokens` : ''}`,
      );
    } else if (sub === 'session_state_changed') {
      if (m.state === 'running') s.status = 'working';
      else if (m.state === 'requires_action') s.status = 'waiting';
      else if (m.state === 'idle' && !s.approvals.length) s.status = 'ready';
    } else if (sub === 'api_retry') {
      s.activity = `Reintentando la petición (${m.attempt}/${m.max_retries})…`;
    } else if (sub === 'model_refusal_fallback' || sub === 'model_refusal_no_fallback') {
      note(s, 'warning', m.content ?? 'El modelo rechazó la petición.');
    } else if (sub === 'local_command_output') {
      note(s, 'command', m.content ?? '');
    } else if (sub === 'informational') {
      note(s, m.level === 'warning' ? 'warning' : 'info', m.content ?? '');
    } else if (sub === 'notification') {
      if (m.priority !== 'low') note(s, 'info', m.text ?? '');
    } else if (sub === 'permission_denied') {
      note(s, 'warning', `Permiso denegado para ${m.tool_name}. ${m.message ?? ''}`.trim());
    } else if (sub === 'hook_response') {
      if (m.outcome === 'error')
        note(
          s,
          'warning',
          `Hook ${m.hook_name} (${m.hook_event}) falló. ${m.stderr || m.output || ''}`.trim(),
        );
    } else if (sub === 'background_tasks_changed') {
      s.tasks = (m.tasks ?? []).map((t: any) => ({ id: t.task_id, description: t.description }));
    } else if (sub === 'worker_shutting_down') {
      note(s, 'info', `El agente se está cerrando: ${m.reason ?? ''}`);
    }
    return;
  }
  if (m.type === 'auth_status') {
    if (m.error) s.error = m.error;
    if (m.isAuthenticating) s.activity = 'Autenticando…';
    return;
  }
  if (m.type === 'rate_limit_event') {
    const r = m.rate_limit_info ?? {};
    s.rateLimit = {
      fiveHour:
        r.unifiedWindows?.five_hour?.utilization ??
        (r.rateLimitType === 'five_hour' ? r.utilization : undefined),
      sevenDay:
        r.unifiedWindows?.seven_day?.utilization ??
        (r.rateLimitType === 'seven_day' ? r.utilization : undefined),
      resetsAt: r.resetsAt,
      status: r.status,
    };
    if (r.status === 'rejected')
      note(s, 'error', 'Límite de uso alcanzado. Espera a que se restablezca.');
    return;
  }
  if (m.type === 'tool_progress') {
    const b = findTool(s, m.tool_use_id);
    if (b && b.type === 'tool_use') b.elapsed = m.elapsed_time_seconds;
    return;
  }
  if (m.type === 'task_notification') {
    note(
      s,
      'info',
      `Tarea en segundo plano: ${m.summary ?? m.description ?? m.status ?? 'actualizada'}`,
    );
    return;
  }
  if (m.type === 'conversation_reset') {
    note(s, 'info', 'Conversación reiniciada.');
  }
}
