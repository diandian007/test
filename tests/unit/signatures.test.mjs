import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIGNATURES, matchSignatures, getSignature } from '../../src/knowledge/signatures.mjs';

test('signatures: each signature has ≥1 positive and ≥1 negative example', () => {
  assert.ok(SIGNATURES.length >= 10, `expected ≥10 signatures, got ${SIGNATURES.length}`);
  for (const sig of SIGNATURES) {
    assert.ok(sig.examples, `${sig.id} missing examples`);
    assert.ok(typeof sig.examples.pos === 'string' && sig.examples.pos.length, `${sig.id} needs positive example`);
    assert.ok(typeof sig.examples.neg === 'string' && sig.examples.neg.length, `${sig.id} needs negative example`);
  }
});

test('signatures: each signature matches its positive example and NOT its negative', () => {
  for (const sig of SIGNATURES) {
    const pos = matchSignatures(sig.examples.pos);
    assert.ok(pos.some((c) => c.signature_id === sig.id), `${sig.id} did not match its positive example`);

    const neg = matchSignatures(sig.examples.neg);
    assert.ok(!neg.some((c) => c.signature_id === sig.id), `${sig.id} falsely matched its negative example`);
  }
});

test('signatures: candidates carry evidence_line + root_cause_layer + next_probe_hint (no final verdict)', () => {
  const c = matchSignatures('FATAL: password authentication failed for user "netbox"');
  assert.ok(c.length >= 1);
  const hit = c[0];
  assert.equal(hit.root_cause_layer, 'credential');
  assert.ok(hit.evidence_line);
  assert.ok(hit.next_probe_hint);
  assert.ok(hit.confidence > 0);
  // fault_classify must NOT return a single verdict — returns a list of candidates
  assert.ok(Array.isArray(c));
});

test('signatures: composite orchestration signature requires BOTH signals', () => {
  const onlyHealth = 'healthcheck: starting';
  const onlyMigrating = 'Running netbox migrations 0001_initial';
  const both = 'healthcheck: starting\nRunning netbox migrations 0001_initial';

  assert.equal(matchSignatures(onlyHealth).some((c) => c.signature_id === 'SIG-ORCH-START-PERIOD'), false);
  assert.equal(matchSignatures(onlyMigrating).some((c) => c.signature_id === 'SIG-ORCH-START-PERIOD'), false);
  assert.equal(matchSignatures(both).some((c) => c.signature_id === 'SIG-ORCH-START-PERIOD'), true);
});

test('signatures: no match on benign evidence', () => {
  assert.deepEqual(matchSignatures('all systems nominal, everything is fine'), []);
});

test('signatures: appliesTo filter respected', () => {
  // SECRET key signature applies_to log; filtering by inspect should skip it
  const c = matchSignatures('OOMKilled=true', { appliesTo: 'log' });
  assert.equal(c.some((x) => x.signature_id === 'SIG-RES-OOMKILLED'), false);
  const c2 = matchSignatures('OOMKilled=true', { appliesTo: 'inspect' });
  assert.equal(c2.some((x) => x.signature_id === 'SIG-RES-OOMKILLED'), true);
});
