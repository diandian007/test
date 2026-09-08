// Recorder: writes trace.jsonl (one ToolEvent per line), trace.md, report.md,
// and copies the fixture into the run dir. report.md is a pure function of the
// trace events → deterministic on replay (same trace → same report bytes).

import { appendFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function makeRunId() {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHMMSS UTC
  const short = randomUUID().slice(0, 8);
  return `${ts}-${short}`;
}

export class Recorder {
  constructor({ runDir, runId, fixtureSrc }) {
    this.runDir = runDir;
    this.runId = runId || makeRunId();
    this.fixtureSrc = fixtureSrc;
    this.events = [];
    this.tracePath = join(this.runDir, 'trace.jsonl');
    this.mdPath = join(this.runDir, 'trace.md');
    this.reportPath = join(this.runDir, 'report.md');
    mkdirSync(this.runDir, { recursive: true });
  }

  /** Copy the source fixture into the run dir (read-only data source → working copy). */
  copyFixture() {
    if (this.fixtureSrc && existsSync(this.fixtureSrc)) {
      const dest = join(this.runDir, 'fixture');
      cpSync(this.fixtureSrc, dest, { recursive: true });
      this.fixtureDir = dest;
      return dest;
    }
    return null;
  }

  /** Subscribe to an EventBus. */
  attach(bus) {
    this.unsub = bus.on((te) => this._on(te));
    return this.unsub;
  }

  _on(te) {
    this.events.push(te);
    appendFileSync(this.tracePath, JSON.stringify(te) + '\n');
  }

  /** Finalize: write trace.md and report.md. */
  finalize() {
    writeFileSync(this.mdPath, generateTraceMd(this.events, this.runId));
    writeFileSync(this.reportPath, generateReportMd(this.events, this.runId));
    return { tracePath: this.tracePath, mdPath: this.mdPath, reportPath: this.reportPath };
  }

  /** Regenerate report.md from a recorded trace.jsonl (replay determinism). */
  static regenerateFromTrace(tracePath, outReportPath) {
    const lines = readFileSync(tracePath, 'utf8').split('\n').filter(Boolean);
    const events = lines.map((l) => JSON.parse(l));
    const report = generateReportMd(events, 'replay');
    writeFileSync(outReportPath, report);
    return outReportPath;
  }
}

// ---------------------------------------------------------------------------
// trace.md — human-readable timeline
// ---------------------------------------------------------------------------
export function generateTraceMd(events, runId) {
  const lines = [];
  lines.push(`# Trace ${runId}`);
  lines.push('');
  lines.push('| seq | ts | type | tool | status | dur(ms) | summary |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const e of events) {
    lines.push(`| ${e.seq ?? ''} | ${isoTs(e.ts)} | ${e.type} | ${e.tool_name || ''} | ${e.status || ''} | ${e.duration_ms ?? ''} | ${(e.args_summary || e.result_summary || e.error || e.text || '').slice(0, 80).replace(/\|/g, '\\|')} |`);
  }
  return lines.join('\n') + '\n';
}

function isoTs(ts) {
  if (!ts) return '';
  try { return new Date(ts).toISOString(); } catch { return ''; }
}

// ---------------------------------------------------------------------------
// report.md — four-section template (spec §3), pure function of events
// ---------------------------------------------------------------------------
export function generateReportMd(events, runId) {
  const findings = extractFindings(events);
  const verify = extractVerify(events);
  const actions = extractActions(events);

  const L = [];
  L.push(`# SRE Agent Report — ${runId}`);
  L.push('');

  // ## 1. 发现清单
  L.push('## 1. 发现清单');
  L.push('');
  if (findings.length === 0) {
    L.push('_No findings recorded._');
  } else {
    L.push('| id | rule_id | severity | layer | source | status |');
    L.push('|---|---|---|---|---|---|');
    for (const f of findings) {
      const src = `${f.source?.file || ''}:${f.source?.line || ''}`;
      L.push(`| ${f.id} | ${f.rule_id} | ${f.severity} | ${f.layer} | ${src} | ${f.status} |`);
    }
  }
  L.push('');

  // ## 2. 根因与依据
  L.push('## 2. 根因与依据');
  L.push('');
  if (findings.length === 0) {
    L.push('_No root causes (clean baseline)._');
  } else {
    for (const f of findings) {
      const src = `${f.source?.file || ''}:${f.source?.line || ''}`;
      L.push(`- **${f.rule_id}** (${f.severity}): ${f.observed} — evidence: ${f.evidence || src}`);
    }
  }
  L.push('');

  // ## 3. 已执行动作
  L.push('## 3. 已执行动作');
  L.push('');
  if (actions.length === 0) {
    L.push('_No remediation actions executed._');
  } else {
    L.push('| tool | args | product | ts |');
    L.push('|---|---|---|---|');
    for (const a of actions) {
      L.push(`| ${a.tool} | ${a.args} | ${a.product} | ${isoTs(a.ts)} |`);
    }
  }
  L.push('');

  // ## 4. 验证结果与遗留风险
  L.push('## 4. 验证结果与遗留风险');
  L.push('');
  if (verify) {
    L.push(`**before:** ${verify.before} findings · **after:** ${verify.after} findings`);
    L.push('');
    if (verify.resolved.length) {
      L.push('**Resolved:** ' + verify.resolved.join(', '));
    }
    if (verify.remaining.length) {
      L.push('');
      L.push('**Still open (auto-fixable):** ' + verify.remaining.join(', '));
    }
    if (verify.advisory.length) {
      L.push('');
      L.push('**Advisory (not auto-fixable — secrets/credentials, not rotated):** ' + verify.advisory.join(', '));
    }
    L.push('');
    L.push('_CRITICAL secrets remain plaintext in env files; migrate to Docker secrets (see fix_hint). Not auto-rotated — honest boundary._');
  } else {
    L.push('_config_verify not run; no verification data._');
  }
  L.push('');

  return L.join('\n');
}

// ---- extractors (pure) ----
function extractFindings(events) {
  // prefer config_verify before.findings; else repo_scan findings
  const cv = lastToolResult(events, 'config_verify');
  if (cv?.before?.findings) return cv.before.findings;
  const rs = lastToolResult(events, 'repo_scan');
  return rs?.findings || [];
}

function extractVerify(events) {
  const cv = lastToolResult(events, 'config_verify');
  if (!cv) return null;
  return {
    before: cv.before?.finding_count ?? 0,
    after: cv.after?.finding_count ?? 0,
    resolved: (cv.summary?.resolved || []).map((x) => x.rule_id),
    remaining: (cv.summary?.remaining || []).map((x) => x.rule_id),
    advisory: (cv.summary?.advisory || []).map((x) => x.rule_id),
  };
}

function extractActions(events) {
  const out = [];
  const starts = new Map();
  for (const e of events) {
    if (e.type === 'tool_start') starts.set(e.tool_call_id, e);
    if (e.type === 'tool_end' || e.type === 'tool_error') {
      const s = starts.get(e.tool_call_id);
      const tool = e.tool_name;
      let product = '-';
      if (tool === 'override_generate' && e.result_details?.written) product = e.result_details.written;
      out.push({ tool, args: (s?.args_summary || '').slice(0, 100), product, ts: e.ts });
    }
  }
  return out;
}

function lastToolResult(events, toolName) {
  let last = null;
  for (const e of events) {
    if ((e.type === 'tool_end') && e.tool_name === toolName && e.result_details) {
      last = e.result_details;
    }
  }
  return last;
}
