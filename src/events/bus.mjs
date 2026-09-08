// Event bus: maps pi AgentSessionEvent → spec ToolEvent (§3) and fans out to
// subscribers (recorder / dashboard SSE / report / guard).
// Live mode: attach(session) subscribes to session events and maps them.
// Replay mode: feed recorded ToolEvents back through emit() — same listeners, same render path.

const TOOL_PHASE = {
  repo_scan: 'discover',
  stack_status: 'discover',
  rule_explain: 'diagnose',
  file_read: 'diagnose',
  fault_classify: 'diagnose',
  container_logs: 'diagnose',
  http_probe: 'diagnose',
  override_generate: 'remediate',
  stack_reapply: 'remediate',
  service_restart: 'remediate',
  config_verify: 'verify',
  health_verify: 'verify',
};

function phaseFor(toolName) {
  return TOOL_PHASE[toolName] || 'other';
}

function summarize(obj, max = 240) {
  let s;
  try {
    s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  } catch {
    s = String(obj);
  }
  if (s.length > max) return s.slice(0, max) + '…';
  return s;
}

// parse a tool result's text content into an object (best-effort)
function parseResultContent(result) {
  if (!result || !result.content) return undefined;
  for (const c of result.content) {
    if (c && c.type === 'text' && typeof c.text === 'string') {
      try { return JSON.parse(c.text); } catch { return { text: c.text }; }
    }
  }
  return undefined;
}

export class EventBus {
  constructor(runId) {
    this.runId = runId;
    this.seq = 0;
    this.listeners = new Set();
    this.toolStartTs = new Map(); // toolCallId → ts
    this.toolArgs = new Map();    // toolCallId → args (for guard repeat detection)
    this.startedAt = Date.now();
  }

  /** Register a listener receiving (toolEvent, rawSessionEvent). Returns unsubscribe. */
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Attach to a live pi session. Returns the unsubscribe function. */
  attach(session) {
    if (!session || typeof session.subscribe !== 'function') {
      throw new Error('EventBus.attach: session has no subscribe()');
    }
    return session.subscribe((ev) => this._handle(ev));
  }

  /** Emit a pre-formed ToolEvent (replay path) to all listeners. */
  emit(toolEvent) {
    for (const fn of this.listeners) fn(toolEvent, null);
  }

  _nextSeq() {
    return ++this.seq;
  }

  _dispatch(toolEvent) {
    for (const fn of this.listeners) fn(toolEvent, null);
  }

  _handle(ev) {
    const events = this._map(ev);
    for (const te of events) {
      if (te) this._dispatch(te);
    }
  }

  _map(ev) {
    const out = [];
    switch (ev.type) {
      case 'tool_execution_start': {
        const ts = Date.now();
        this.toolStartTs.set(ev.toolCallId, ts);
        this.toolArgs.set(ev.toolCallId, ev.args);
        out.push({
          ts, run_id: this.runId, seq: this._nextSeq(),
          type: 'tool_start',
          tool_call_id: ev.toolCallId,
          tool_name: ev.toolName,
          args_summary: summarize(ev.args),
          status: 'running',
          phase_hint: phaseFor(ev.toolName),
        });
        break;
      }
      case 'tool_execution_end': {
        const startTs = this.toolStartTs.get(ev.toolCallId) || Date.now();
        const duration_ms = Date.now() - startTs;
        this.toolStartTs.delete(ev.toolCallId);
        const details = parseResultContent(ev.result);
        out.push({
          ts: Date.now(), run_id: this.runId, seq: this._nextSeq(),
          type: ev.isError ? 'tool_error' : 'tool_end',
          tool_call_id: ev.toolCallId,
          tool_name: ev.toolName,
          status: ev.isError ? 'error' : 'finished',
          duration_ms,
          result_summary: summarize(ev.result?.content?.[0]?.text || ev.result),
          result_details: details,
          error: ev.isError ? summarize(ev.result?.content?.[0]?.text) : undefined,
          phase_hint: phaseFor(ev.toolName),
        });
        break;
      }
      case 'message_update':
      case 'message_end': {
        const text = extractText(ev.message);
        if (text) {
          out.push({
            ts: Date.now(), run_id: this.runId, seq: this._nextSeq(),
            type: 'text_delta',
            text: text.slice(0, 2000),
          });
        }
        break;
      }
      case 'turn_start':
        out.push({ ts: Date.now(), run_id: this.runId, seq: this._nextSeq(), type: 'turn_start' });
        break;
      case 'turn_end':
        out.push({ ts: Date.now(), run_id: this.runId, seq: this._nextSeq(), type: 'turn_end' });
        break;
      case 'agent_end':
      case 'agent_settled':
        out.push({ ts: Date.now(), run_id: this.runId, seq: this._nextSeq(), type: 'agent_end' });
        break;
      default:
        break;
    }
    return out;
  }
}

function extractText(message) {
  if (!message) return '';
  if (typeof message === 'string') return message;
  if (message.content && Array.isArray(message.content)) {
    return message.content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('');
  }
  if (message.text) return message.text;
  return '';
}

export { phaseFor };
