import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../../src/events/bus.mjs';
import { Recorder, generateReportMd, generateTraceMd } from '../../src/trace/recorder.mjs';
import { startDashboard, replayEvents } from '../../src/dashboard/server.mjs';

function fakeResult(text) { return { content: [{ type: 'text', text }] }; }

function recordTrace(dir, runId) {
  const rec = new Recorder({ runDir: dir, runId });
  const bus = new EventBus(runId);
  rec.attach(bus);
  bus._handle({ type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'repo_scan', args: {} });
  bus._handle({ type: 'tool_execution_end', toolCallId: 'tc1', toolName: 'repo_scan',
    result: fakeResult(JSON.stringify({ findings: [{ id: 'F-01', rule_id: 'NET-001', severity: 'HIGH', layer: 'static', source: { file: 'env/netbox.env', line: 2 }, status: 'open' }], repo: { version: '5.1.0' } })), isError: false });
  bus._handle({ type: 'tool_execution_start', toolCallId: 'tc2', toolName: 'config_verify', args: {} });
  bus._handle({ type: 'tool_execution_end', toolCallId: 'tc2', toolName: 'config_verify',
    result: fakeResult(JSON.stringify({ before: { finding_count: 1, findings: [{ id: 'F-01', rule_id: 'NET-001', severity: 'HIGH', layer: 'static', source: { file: 'env/netbox.env', line: 2 }, status: 'open' }] }, after: { finding_count: 0 }, summary: { resolved: [{ rule_id: 'NET-001' }], remaining: [], advisory: [] } })), isError: false });
  bus._handle({ type: 'agent_settled' });
  rec.finalize();
  return rec;
}

test('replay: replayEvents returns the same ToolEvents that were recorded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpy-'));
  try {
    recordTrace(dir, 'rpy-1');
    const evs = replayEvents(join(dir, 'trace.jsonl'));
    assert.ok(evs.length >= 4);
    assert.equal(evs[0].type, 'tool_start');
    assert.equal(evs[1].type, 'tool_end');
    assert.equal(evs.find((e) => e.type === 'tool_end' && e.tool_name === 'config_verify').tool_name, 'config_verify');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('replay: report determinism — same trace → identical report bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'det-'));
  try {
    recordTrace(dir, 'det-1');
    const tracePath = join(dir, 'trace.jsonl');
    const evs = replayEvents(tracePath);

    const r1 = generateReportMd(evs, 'det-1');
    const r2 = generateReportMd(evs, 'det-1');
    assert.equal(r1, r2, 'same trace must produce identical report');

    // regenerate a second time via the static method
    const outA = join(dir, 'reportA.md');
    const outB = join(dir, 'reportB.md');
    Recorder.regenerateFromTrace(tracePath, outA);
    Recorder.regenerateFromTrace(tracePath, outB);
    assert.equal(readFileSync(outA, 'utf8'), readFileSync(outB, 'utf8'), 'regenerate must be byte-stable');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('replay: report contains findings + actions + verify from the trace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rep-'));
  try {
    recordTrace(dir, 'rep-1');
    const report = readFileSync(join(dir, 'report.md'), 'utf8');
    assert.ok(report.includes('NET-001'), 'report must list the finding');
    assert.ok(report.includes('repo_scan'), 'report must list the action');
    assert.ok(report.includes('## 4.'), 'report must have verify section');
    assert.ok(report.includes('Resolved'), 'verify section must show resolved');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('replay: dashboard replay mode serves index + events SSE + report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dash-'));
  try {
    recordTrace(dir, 'dash-1');
    const tracePath = join(dir, 'trace.jsonl');
    const dash = await startDashboard({ port: 9421, tracePath });
    try {
      const port = dash.port;
      // index.html served
      const idx = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(idx.status, 200);
      const idxText = await idx.text();
      assert.ok(idxText.includes('NetBox SRE Agent'));

      // /report serves report.md
      const rep = await fetch(`http://127.0.0.1:${port}/report`);
      assert.equal(rep.status, 200);
      const repText = await rep.text();
      assert.ok(repText.includes('NET-001'));

      // /events SSE streams the recorded events (then 'done')
      const sse = await fetch(`http://127.0.0.1:${port}/events`);
      assert.equal(sse.status, 200);
      const text = await sse.text();
      assert.ok(text.includes('event: event'), 'SSE must contain event frames');
      assert.ok(text.includes('repo_scan'), 'SSE must include the repo_scan tool event');
      assert.ok(text.includes('event: done'), 'replay must signal completion');
    } finally {
      dash.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
