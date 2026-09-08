import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScanContext, scan, RULES, explainRule } from '../../src/knowledge/rules.mjs';
import { makeFixture, cleanupFixture } from '../helpers.mjs';

test('scanner: 14 rules defined', () => {
  assert.equal(RULES.length, 14);
  const ids = RULES.map((r) => r.id);
  for (const id of ['SECRET-001','SECRET-002','SECRET-003','SECRET-004','NET-001','NET-002','NET-003','NET-004','NET-005','NET-006','OBS-001','OBS-002','OPS-001','OPS-002']) {
    assert.ok(ids.includes(id), `missing ${id}`);
  }
});

test('scanner: full coverage on golden fixture → 16 findings, all rules trigger', () => {
  const dir = makeFixture();
  try {
    const ctx = buildScanContext(dir, { withOverride: false });
    const findings = scan(ctx, {});
    assert.equal(findings.length, 16, `expected 16 findings, got ${findings.length}`);

    // every rule triggers at least once
    const triggered = new Set(findings.map((f) => f.rule_id));
    assert.equal(triggered.size, 14, 'all 14 rules must trigger');

    // instance counts: SECRET-003 = 2 (redis + redis-cache), NET-006 = 2 (tasks + cache)
    const byRule = {};
    for (const f of findings) byRule[f.rule_id] = (byRule[f.rule_id] || 0) + 1;
    assert.equal(byRule['SECRET-003'], 2, 'SECRET-003 must have 2 instances');
    assert.equal(byRule['NET-006'], 2, 'NET-006 must have 2 instances');
    for (const id of ['SECRET-001','SECRET-002','SECRET-004','NET-001','NET-002','NET-003','NET-004','NET-005','OBS-001','OBS-002','OPS-001','OPS-002']) {
      assert.equal(byRule[id], 1, `${id} should be 1 instance`);
    }
  } finally { cleanupFixture(dir); }
});

test('scanner: auto_fixable flags correct', () => {
  const dir = makeFixture();
  try {
    const ctx = buildScanContext(dir, { withOverride: false });
    const findings = scan(ctx, {});
    const byId = {};
    for (const f of findings) byId[f.rule_id] = f;
    // auto_fixable: NET-001, NET-003, NET-004, NET-005, NET-006, OBS-001
    for (const id of ['NET-001','NET-003','NET-004','NET-005','NET-006','OBS-001']) {
      assert.equal(byId[id].auto_fixable, true, `${id} should be auto_fixable`);
    }
    // NOT auto_fixable: secrets, NET-002, OBS-002, OPS-001, OPS-002
    for (const id of ['SECRET-001','SECRET-002','SECRET-003','SECRET-004','NET-002','OBS-002','OPS-001','OPS-002']) {
      assert.equal(byId[id].auto_fixable, false, `${id} should NOT be auto_fixable`);
    }
  } finally { cleanupFixture(dir); }
});

test('scanner: every finding has layer=static + source + evidence + status open', () => {
  const dir = makeFixture();
  try {
    const ctx = buildScanContext(dir, { withOverride: false });
    const findings = scan(ctx, {});
    for (const f of findings) {
      assert.equal(f.layer, 'static');
      assert.ok(f.source && f.source.file, `${f.id} missing source.file`);
      assert.ok(f.evidence, `${f.id} missing evidence`);
      assert.equal(f.status, 'open');
      assert.ok(f.severity, `${f.id} missing severity`);
    }
  } finally { cleanupFixture(dir); }
});

test('scanner: repo summary', () => {
  const dir = makeFixture();
  try {
    const ctx = buildScanContext(dir, { withOverride: false });
    assert.equal(ctx.version, '5.1.0');
    assert.ok(ctx.services.includes('netbox'));
    assert.ok(ctx.services.includes('postgres'));
    assert.ok(ctx.services.includes('redis'));
    assert.ok(ctx.services.includes('redis-cache'));
    assert.equal(ctx.services.length, 5);
    assert.ok(ctx.imageTag.includes('v4.7-5.1.0'));
  } finally { cleanupFixture(dir); }
});

test('rule_explain: returns mechanism/impact/remediation/auto_fixable/fix_hint', () => {
  const info = explainRule('NET-001');
  assert.equal(info.rule_id, 'NET-001');
  assert.equal(info.auto_fixable, true);
  assert.ok(info.mechanism);
  assert.ok(info.impact);
  assert.ok(info.remediation);
  assert.ok(info.fix_hint);
  assert.equal(explainRule('NOPE'), null);
});
