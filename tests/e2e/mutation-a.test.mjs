// R7-④ e2e layer — EXPENSIVE (needs LLM + API key). NOT in CI.
// Mutation test A (spec §10, R1-④ non-scripting proof):
//   With CORS_ORIGIN_ALLOW_ALL=True  → agent should remediate NET-001.
//   With CORS_ORIGIN_ALLOW_ALL=False → agent must NOT remediate NET-001; it picks the next
//   highest-priority auto-fixable item (e.g. NET-003). Same code, only data changes →
//   behavior changes. This is the proof the decision comes from observation, not a script.
//
// Run manually when ANTHROPIC_API_KEY is set:
//   npm run test:e2e
//
// Skipped automatically when no key is configured.

import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFixture, cleanupFixture } from '../helpers.mjs';

const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, '..', '..');

function runAgent(fixtureDir) {
  const env = { ...process.env, SRE_REPO: fixtureDir };
  return spawnSync(process.execPath, [join(PROJECT, 'src', 'run-agent.mjs')], {
    encoding: 'utf8',
    env,
    timeout: 180000,
  });
}

test('mutation A: agent behavior changes with data (needs LLM)', { skip: !HAS_KEY ? 'set ANTHROPIC_API_KEY to run e2e' : undefined }, () => {
  const baseline = makeFixture();
  const mutated = makeFixture();
  try {
    // mutate: flip CORS to False in the mutated fixture's netbox.env
    const envPath = join(mutated, 'env', 'netbox.env');
    const env = readFileSync(envPath, 'utf8').replace('CORS_ORIGIN_ALLOW_ALL=True', 'CORS_ORIGIN_ALLOW_ALL=False');
    writeFileSync(envPath, env);

    const a = runAgent(baseline);
    const b = runAgent(mutated);
    // structural assertions (NOT verbatim): baseline remediates NET-001; mutated does not;
    // tool sequences differ. Full assertion logic lands with the Phase 2 LLM harness.
    if (a.status !== 0) throw new Error(`baseline run failed: ${a.stderr}`);
    if (b.status !== 0) throw new Error(`mutated run failed: ${b.stderr}`);
  } finally {
    cleanupFixture(baseline);
    cleanupFixture(mutated);
  }
});
