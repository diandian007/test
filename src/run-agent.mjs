// Entry point: env-check → fixture → createAgentSession → bus/recorder/guard → prompt → report.
//   node src/run-agent.mjs              # demo:static (needs API key)
//   node src/run-agent.mjs --env-check
//   node src/run-agent.mjs --ui          # demo:static + dashboard
//   node src/run-agent.mjs --replay traces/<run-id>/trace.jsonl
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createAgentSession, SessionManager, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { getModel } from '@earendil-works/pi-ai/compat';

import { customTools, TOOL_NAMES, setToolContext } from './tools/registry.mjs';
import { EventBus } from './events/bus.mjs';
import { Recorder, makeRunId } from './trace/recorder.mjs';
import { BudgetGuard } from './guard/budget.mjs';
import { startDashboard } from './dashboard/server.mjs';
import { envCheck, formatEnvCheck, DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_THINKING } from './env-check.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const REPO_SRC = process.env.SRE_REPO || resolve(PROJECT_ROOT, 'netbox-docker');

const argv = process.argv.slice(2);
const ui = argv.includes('--ui');
const envCheckMode = argv.includes('--env-check');
const replayIdx = argv.indexOf('--replay');
const replayTrace = replayIdx >= 0 ? argv[replayIdx + 1] : null;

async function main() {
  // --- env-check mode ---
  if (envCheckMode) {
    console.log(formatEnvCheck(envCheck()));
    return;
  }

  // --- replay mode ---
  if (argv.includes('--replay') || replayTrace) {
    if (!replayTrace || !existsSync(replayTrace)) {
      console.error('usage: --replay traces/<run-id>/trace.jsonl');
      process.exit(1);
    }
    const reportPath = replayTrace.replace(/trace\.jsonl$/, 'report.md');
    const dash = await startDashboard({ port: 9377, tracePath: replayTrace, reportPath });
    console.log(`[replay] trace: ${replayTrace}`);
    console.log(`[replay] dashboard ready — Ctrl-C to exit`);
    // keep alive
    const stop = () => { dash.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }

  // --- demo:static (live) ---
  const env = envCheck();
  console.log(formatEnvCheck(env));
  if (!env.apiKey.ready) {
    console.error('\n✖ API key required for live run. Set ANTHROPIC_API_KEY or run `pi auth` to populate ~/.pi/agent/auth.json.');
    console.error('  (Unit/contract/replay tests run without a key: `npm test`)');
    process.exit(2);
  }
  if (!env.model.available) {
    console.error(`\n✖ model ${env.model.provider}/${env.model.id} not in catalog. Set SRE_MODEL_ID.`);
    process.exit(2);
  }

  // 1. run dir + fixture
  const runId = makeRunId();
  const runDir = join(PROJECT_ROOT, 'traces', runId);
  const recorder = new Recorder({ runDir, runId, fixtureSrc: REPO_SRC });
  const fixtureDir = recorder.copyFixture();
  console.log(`[run] ${runId} | fixture: ${fixtureDir}`);
  setToolContext({ fixtureRoot: fixtureDir });

  // 2. model runtime with in-memory key (no ~/.pi writes)
  const modelRuntime = await ModelRuntime.create();
  if (process.env.ANTHROPIC_API_KEY) {
    await modelRuntime.setRuntimeApiKey(DEFAULT_PROVIDER, process.env.ANTHROPIC_API_KEY);
  }
  const model = getModel(env.model.provider, env.model.id);
  // Honor ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN when present (e.g. proxy
  // like zenmux.ai). The catalog hardcodes https://api.anthropic.com and the
  // SDK sends x-api-key; a Bearer-token proxy needs both the baseURL and an
  // explicit Authorization header to authenticate.
  if (process.env.ANTHROPIC_BASE_URL) {
    model.baseUrl = process.env.ANTHROPIC_BASE_URL;
  }
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    model.headers = {
      ...(model.headers || {}),
      Authorization: `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`,
    };
  }

  // 3. session (tool isolation: no builtins, only our 12 custom tools)
  const { session } = await createAgentSession({
    cwd: fixtureDir,
    model,
    thinkingLevel: env.model.thinking,
    noTools: 'builtin',
    tools: TOOL_NAMES,
    customTools,
    sessionManager: SessionManager.inMemory(fixtureDir),
    modelRuntime,
  });

  // 4. wire bus → recorder / guard / dashboard
  const bus = new EventBus(runId);
  recorder.attach(bus);
  const guard = new BudgetGuard({ inject: (msg) => session.steer(msg) });
  guard.attach(bus);
  bus.attach(session);

  let dash = null;
  if (ui) {
    const reportPath = join(runDir, 'report.md');
    dash = await startDashboard({ port: 9377, bus, reportPath });
  }

  // 5. prompt
  const systemPrompt = readFileSync(join(__dirname, 'prompts', 'system.md'), 'utf8');
  const task = `## Task (Phase 1, static)

Perform a configuration inspection of the fixture at \`${fixtureDir}\`.
1. repo_scan to enumerate findings.
2. Pick the highest-priority **auto-fixable** finding and diagnose it (rule_explain / file_read).
3. override_generate to remediate that ONE finding (scope lock — advise on the rest).
4. config_verify to confirm it is fixed.

Fix exactly one item. Secrets are advisory only. Stop once config_verify confirms the fix.`;
  console.log('[run] prompting agent…');
  await session.prompt(systemPrompt + '\n\n' + task);
  await session.waitForIdle();

  // 6. finalize then metrics — report.md must exist on disk before the metrics
  // event reaches the dashboard, otherwise the browser's renderReport() fetch
  // hits a 404 and the report panel stays empty.
  const out = recorder.finalize();
  bus.emit({ type: 'metrics', ts: Date.now(), run_id: runId, seq: ++bus.seq, metrics: guard.getMetrics() });
  // give SSE clients a beat to receive metrics and re-fetch /report before exit
  await new Promise((r) => setTimeout(r, 500));
  session.dispose?.();

  // 7. report
  console.log('\n=== run complete ===');
  console.log(`trace  : ${out.tracePath}`);
  console.log(`report : ${out.reportPath}`);
  console.log('convergence:', JSON.stringify(guard.acceptance()));
  if (dash) {
    console.log(`dashboard served on http://127.0.0.1:${dash.port} — Ctrl-C to exit`);
    const stop = () => { dash.close(); session.dispose?.(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('fatal:', e?.stack || e);
  process.exit(1);
});
