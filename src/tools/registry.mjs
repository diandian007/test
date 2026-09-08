// Registry: wraps pure core tools into pi SDK ToolDefinitions via defineTool().
// Exports customTools[] (for createAgentSession customTools) + TOOL_NAMES allowlist.

import { defineTool } from '@earendil-works/pi-coding-agent';
import { STATIC_TOOLS, RUNTIME_TOOLS } from './core.mjs';

const ALL_TOOLS = [...STATIC_TOOLS, ...RUNTIME_TOOLS];

// Build a ToolDefinition from a core tool. The shared toolCtx (fixture/runtime
// state) is injected at run time via setToolContext().
let _toolCtx = {};

export function setToolContext(ctx) {
  _toolCtx = ctx || {};
}

function wrapExecute(coreTool) {
  return async function execute(toolCallId, params, _signal, _onUpdate, _piCtx) {
    let result;
    try {
      // params may be validated by pi against the TypeBox schema already; still
      // guard against bad/missing args so we never crash — return structured error.
      if (params && typeof params === 'object' && Array.isArray(params)) {
        result = { ok: false, error: 'invalid_args', hint: 'expected object params' };
      } else {
        result = await coreTool.execute(_toolCtx, params || {});
      }
    } catch (e) {
      result = { ok: false, error: 'tool_exception', message: e?.message || String(e) };
    }
    // On success, unwrap to the data payload so consumers (agent, recorder,
    // dashboard) deal with the data directly. On failure, return the full
    // structured error so the agent sees {error, hint, degraded}.
    const payload = result && result.ok === true ? result.data : result;
    const text = JSON.stringify(payload, null, 2);
    return { content: [{ type: 'text', text }], details: payload };
  };
}

export const customTools = ALL_TOOLS.map((t) =>
  defineTool({
    name: t.name,
    label: t.label,
    description: t.description,
    promptSnippet: t.promptSnippet,
    parameters: t.parameters,
    execute: wrapExecute(t),
  })
);

export const TOOL_NAMES = ALL_TOOLS.map((t) => t.name);

export const STATIC_TOOL_NAMES = STATIC_TOOLS.map((t) => t.name);
export const RUNTIME_TOOL_NAMES = RUNTIME_TOOLS.map((t) => t.name);

export function listTools() {
  return ALL_TOOLS.map((t) => ({ name: t.name, label: t.label, phase: STATIC_TOOLS.includes(t) ? 'L1' : 'L2' }));
}
