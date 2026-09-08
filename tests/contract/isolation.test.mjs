import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent';
import { customTools, TOOL_NAMES, setToolContext } from '../../src/tools/registry.mjs';

// R7-② / R1-①: Agent's active tool set == custom tools, NO built-in read/bash/edit/write.
// This runs with ZERO LLM calls (createAgentSession defers auth to prompt time).

test('isolation: session.getActiveToolNames() == custom tool set (no builtins)', async () => {
  setToolContext({ fixtureRoot: '/tmp' });
  const { session } = await createAgentSession({
    cwd: '/tmp',
    noTools: 'builtin',
    tools: TOOL_NAMES,
    customTools,
    sessionManager: SessionManager.inMemory('/tmp'),
  });
  try {
    const active = session.getActiveToolNames().slice().sort();
    const expected = TOOL_NAMES.slice().sort();
    assert.deepEqual(active, expected, 'active tools must equal the custom tool set');
    for (const builtin of ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'powershell']) {
      assert.ok(!active.includes(builtin), `built-in tool ${builtin} must not be present`);
    }
    assert.equal(active.length, expected.length);
    assert.ok(active.length >= 12, 'expected ≥12 custom tools');
  } finally {
    if (typeof session.dispose === 'function') session.dispose();
  }
});

test('isolation: TOOL_NAMES contains all 12 tools and is derived from registry', () => {
  assert.equal(customTools.length, TOOL_NAMES.length);
  const expected = ['repo_scan','rule_explain','file_read','override_generate','config_verify','fault_classify','stack_status','container_logs','http_probe','stack_reapply','service_restart','health_verify'];
  assert.deepEqual(TOOL_NAMES.slice().sort(), expected.sort());
  // each customTool is a ToolDefinition with execute + parameters
  for (const t of customTools) {
    assert.ok(t.name, 'tool needs name');
    assert.ok(t.description, `${t.name} needs description`);
    assert.equal(typeof t.execute, 'function', `${t.name} needs execute()`);
    assert.ok(t.parameters, `${t.name} needs parameters schema`);
  }
});

test('isolation: customTools count == TOOL_NAMES count (no duplicates)', () => {
  const names = customTools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'tool names must be unique');
});
