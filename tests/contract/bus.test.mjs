import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/events/bus.mjs';
import { Recorder, makeRunId, generateReportMd } from '../../src/trace/recorder.mjs';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetGuard } from '../../src/guard/budget.mjs';

// R7-②: event bus fanout (recorder/dashboard/report/guard all receive) + trace schema (start/end paired).

function fakeResult(text) {
  return { content: [{ type: 'text', text }] };
}

test('bus: fanout — multiple listeners all receive the same ToolEvents', () => {
  const bus = new EventBus('run-test');
  const got = { a: [], b: [], c: [] };
  bus.on((te) => got.a.push(te));
  bus.on((te) => got.b.push(te));
  bus.on((te) => got.c.push(te));

  // simulate a pi session event stream by calling the private mapper via emit of mapped events:
  // easier: drive _handle with synthetic AgentSessionEvents
  bus._handle({ type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'repo_scan', args: { scope: 'static' } });
  bus._handle({ type: 'tool_execution_end', toolCallId: 'tc1', toolName: 'repo_scan', result: fakeResult('{"ok":true}'), isError: false });
  bus._handle({ type: 'agent_settled' });

  for (const k of ['a', 'b', 'c']) {
    assert.ok(got[k].length >= 3, `listener ${k} received too few events`);
    assert.equal(got[k][0].type, 'tool_start');
    assert.equal(got[k][1].type, 'tool_end');
    assert.equal(got[k][2].type, 'agent_end');
  }
});

test('bus: tool_start/tool_end are paired and carry tool_call_id + duration', () => {
  const bus = new EventBus('run-pair');
  const events = [];
  bus.on((te) => events.push(te));
  bus._handle({ type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'file_read', args: { path: 'env/netbox.env' } });
  bus._handle({ type: 'tool_execution_end', toolCallId: 'tc1', toolName: 'file_read', result: fakeResult('{"ok":true,"data":{}}'), isError: false });

  const start = events.find((e) => e.type === 'tool_start');
  const end = events.find((e) => e.type === 'tool_end');
  assert.ok(start && end);
  assert.equal(start.tool_call_id, 'tc1');
  assert.equal(end.tool_call_id, 'tc1');
  assert.equal(start.status, 'running');
  assert.equal(end.status, 'finished');
  assert.ok(typeof end.duration_ms === 'number');
  assert.ok(end.duration_ms >= 0);
});

test('bus: tool_error emitted when isError=true', () => {
  const bus = new EventBus('run-err');
  const events = [];
  bus.on((te) => events.push(te));
  bus._handle({ type: 'tool_execution_end', toolCallId: 'tc1', toolName: 'stack_status', result: fakeResult('{"ok":false,"error":"docker_unavailable"}'), isError: true });
  const err = events.find((e) => e.type === 'tool_error');
  assert.ok(err, 'tool_error event expected');
  assert.equal(err.status, 'error');
  assert.ok(err.error);
});

test('recorder: trace.jsonl every line parseable, seq increasing, start/end paired', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-'));
  const rec = new Recorder({ runDir: dir, runId: 'rec-test' });
  const bus = new EventBus('rec-test');
  rec.attach(bus);
  bus._handle({ type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'repo_scan', args: {} });
  bus._handle({ type: 'tool_execution_end', toolCallId: 'tc1', toolName: 'repo_scan', result: fakeResult(JSON.stringify({ ok: true, data: { findings: [], repo: { version: '5.1.0' } } })), isError: false });
  bus._handle({ type: 'agent_settled' });
  rec.finalize();

  assert.ok(existsSync(join(dir, 'trace.jsonl')));
  const lines = readFileSync(join(dir, 'trace.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length >= 3);
  const parsed = lines.map((l) => JSON.parse(l)); // must not throw
  const seqs = parsed.map((e) => e.seq);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], 'seq must increase');
  const starts = parsed.filter((e) => e.type === 'tool_start');
  const ends = parsed.filter((e) => e.type === 'tool_end');
  assert.equal(starts.length, 1);
  assert.equal(ends.length, 1);
  assert.equal(starts[0].tool_call_id, ends[0].tool_call_id);

  rmSync(dir, { recursive: true, force: true });
});

test('recorder: report.md has the four required section headers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rep-'));
  const rec = new Recorder({ runDir: dir, runId: 'rep-test' });
  const bus = new EventBus('rep-test');
  rec.attach(bus);
  bus._handle({ type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'repo_scan', args: {} });
  bus._handle({ type: 'tool_execution_end', toolCallId: 'tc1', toolName: 'repo_scan', result: fakeResult(JSON.stringify({ ok: true, data: { findings: [], repo: { version: '5.1.0' } } })), isError: false });
  bus._handle({ type: 'agent_settled' });
  rec.finalize();
  const report = readFileSync(join(dir, 'report.md'), 'utf8');
  assert.ok(report.includes('## 1. 发现清单'));
  assert.ok(report.includes('## 2. 根因与依据'));
  assert.ok(report.includes('## 3. 已执行动作'));
  assert.ok(report.includes('## 4. 验证结果与遗留风险'));
  rmSync(dir, { recursive: true, force: true });
});

test('guard: tracks tool calls + repeat detection + phase regression', () => {
  const bus = new EventBus('guard-test');
  const steered = [];
  const guard = new BudgetGuard({ inject: (m) => steered.push(m), limits: { repeatThreshold: 3 } });
  guard.attach(bus);
  // three identical ToolEvents → repeat steering injected
  for (let i = 0; i < 3; i++) {
    bus.emit({ type: 'tool_start', tool_call_id: `t${i}`, tool_name: 'file_read', args_summary: '{"path":"env/netbox.env"}', phase_hint: 'diagnose' });
  }
  const m = guard.getMetrics();
  assert.equal(m.tool_calls, 3);
  assert.ok(steered.length >= 1, 'repeat steering should fire');
  assert.ok(m.repeat_calls >= 1);
});

test('guard: phase regression detected when going verify → discover', () => {
  const bus = new EventBus('guard-phase');
  const guard = new BudgetGuard({});
  guard.attach(bus);
  bus.emit({ type: 'tool_start', tool_call_id: 't1', tool_name: 'config_verify', args_summary: '{}', phase_hint: 'verify' });
  bus.emit({ type: 'tool_start', tool_call_id: 't2', tool_name: 'repo_scan', args_summary: '{}', phase_hint: 'discover' });
  const m = guard.getMetrics();
  assert.ok(m.phase_regressions >= 1, 'phase regression should be counted');
});

test('recorder+guard+bus: full fanout — all three receive every event', () => {
  const dir = mkdtempSync(join(tmpdir(), 'full-'));
  const rec = new Recorder({ runDir: dir, runId: 'full-test' });
  const guard = new BudgetGuard({});
  const bus = new EventBus('full-test');
  rec.attach(bus);
  guard.attach(bus);
  const dashEvents = [];
  bus.on((te) => dashEvents.push(te));

  bus.emit({ type: 'tool_start', tool_call_id: 'tc1', tool_name: 'repo_scan', args_summary: '{}', phase_hint: 'discover' });
  bus.emit({ type: 'tool_end', tool_call_id: 'tc1', tool_name: 'repo_scan', status: 'finished', duration_ms: 5, result_summary: '{"ok":true}', phase_hint: 'discover' });
  rec.finalize();

  assert.ok(dashEvents.length >= 2, 'dashboard listener received events');
  assert.ok(guard.getMetrics().tool_calls >= 1, 'guard received events');
  assert.ok(existsSync(join(dir, 'trace.jsonl')), 'recorder wrote trace');
  rmSync(dir, { recursive: true, force: true });
});
