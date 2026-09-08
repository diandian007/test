# NetBox SRE Agent

A **true Tool-Calling SRE Agent** over `netbox-docker` (v5.1.0). It autonomously completes the
closed loop **discover → diagnose → remediate → verify** using only a closed set of JSON-Schema
tools — no shell, no hand-written scripts driving the LLM. Built on the pi SDK
(`@earendil-works/pi-coding-agent`).

This is **Phase 1 (L1 static)**: no Docker daemon required. All 12 tools are registered; the
six L2 runtime tools degrade gracefully (`docker_unavailable`) so the agent adapts rather than
crashes. Phase 2 (L2 runtime) slots in by replacing the runtime tools' `execute()` bodies.

## What "true Tool-Calling" means here

- **Tools are the only capability boundary.** The agent has NO `read/bash/edit/write` builtins —
  `createAgentSession({ noTools: "builtin", tools: TOOL_NAMES, customTools })` disables them,
  and the `tools` allowlist re-confines to the 12 custom tools. Verified by a contract test:
  `session.getActiveToolNames()` == the custom set, zero builtins.
- **Decision/execution separation + ReAct loop.** The agent observes tool output and decides the
  next step itself; it is not scripted. Mutation tests prove it.
- **Failure does not crash the agent.** L2 tools return structured `docker_unavailable` errors;
  the agent reads them and falls back to L1.

## The 12 tools

| Phase | Tool | Role |
|---|---|---|
| L1 | `repo_scan` | discover all static findings + repo summary |
| L1 | `rule_explain` | explain a rule (mechanism/impact/remediation/auto_fixable) |
| L1 | `file_read` | fixture-confined evidence read (`../` rejected) |
| L1 | `override_generate` | idempotent `docker-compose.override.yml` for auto-fixable rules |
| L1 | `config_verify` | before/after + resolved/remaining/advisory |
| L1 | `fault_classify` | candidate fault signatures (no final verdict) |
| L2 | `stack_status` / `container_logs` / `http_probe` / `stack_reapply` / `service_restart` / `health_verify` | runtime (Phase 1: degraded stubs; Phase 2: real docker calls) |

## Quick start

```bash
npm install

# environment probe (API key, Docker, compose form, model)
npm run env-check

# run the static closed loop (needs ANTHROPIC_API_KEY)
npm run demo:static
# …with live dashboard on http://127.0.0.1:9377
npm run demo:static -- --ui

# replay a recorded run through the dashboard
npm run replay -- traces/<run-id>/trace.jsonl

# tests (zero LLM, zero Docker, <2s)
npm test
```

## Knowledge base

- **14 static rules** (`src/knowledge/rules.mjs`): SECRET×4, NET×6, OBS×2, OPS×2. Every value,
  default, and line number was verified against the real `netbox-docker` v5.1.0 files.
- **Runtime fault signatures** (`src/knowledge/signatures.mjs`): §6.3, each with ≥1 positive and
  ≥1 negative example, unit-tested. `fault_classify` returns candidates (evidence line +
  confidence + next_probe_hint), never a final verdict — the LLM correlates candidates with
  L1/L2 evidence to conclude.

### Finding instance counts (golden fixture)

`repo_scan` over the clean repo yields **16 findings from 14 rules** — `SECRET-003` and `NET-006`
each have 2 instances (redis + redis-cache). Findings (instances), not rules, are the acceptance
and UI unit (spec §3).

## Closed loop & convergence (R8)

The bus maps pi's `tool_execution_start/end`/`message_*`/`agent_*` events into the spec's
`ToolEvent` and fans out to **recorder / dashboard-SSE / guard**. The guard enforces: ≤15 tool
calls, ≤1 repeat (≥3 identical calls inject a steering message), ≤1 phase regression, and a
budget ceiling; on exhaustion it terminates and emits a "partial" report.

`report.md` is a **pure function of the trace** → byte-identical on replay (tested).

## Testing (R7)

| Layer | LLM | Docker | CI | What |
|---|---|---|---|---|
| ① unit | ✗ | ✗ | ✓ | scanner (14-rule coverage + auto_fixable), signatures (pos/neg), override idempotency + merge, config_verify diff, path traversal, schema-invalid → structured error |
| ② contract | ✗ | ✗ | ✓ | `getActiveToolNames()` == custom set (no builtins), bus fanout, trace.jsonl parseable + start/end paired |
| ③ replay | ✗ | ✗ | ✓ | same trace → identical report bytes; replay SSE == recorded events |
| ④ e2e | ✓ | (P2) | nightly | mutation A/B (non-scripting proof), per-scenario end-to-end |

`npm test` runs ①②③ (37 tests, ~1s, zero LLM, zero Docker).

## Phase 2 extensibility

- `src/tools/runtime-tools.mjs`: the six L2 tools are already registered as degraded stubs;
  Phase 2 replaces their `execute()` with `docker-compose` / `docker inspect` / HTTP probe calls.
  The registry, `TOOL_NAMES`, and the bus/recorder/guard/dashboard are layer-agnostic.
- `harness/fault-driver.mjs`: `fault_inject`/`cleanup` interface (not an agent tool — harness
  responsibility to avoid self-fulfilling loops).
- `pi-extension/netbox-sre-tools.mjs`: V2 optional — same core via `pi.registerTool()` for
  pi-web-ui's own session (a separate run path, not a second view of a V1 run).

## Visualization ecosystem choices (spec §1)

- **V1 self-built lightweight dashboard** (this repo, `src/dashboard/`): `node:http` + SSE +
  single-file native HTML/JS, zero frontend deps, port 9377 (auto-incremented if occupied).
  Live + replay share one render path. **Required.**
- **V2 pi-web-ui** (optional, Phase 2): same tools via `pi.registerTool()`. Demo-only.
- **pi-agent-dashboard**: not adopted (Electron/tunnel heavy dependencies).

## Honest boundaries

- CRITICAL secrets (`SECRET-*`) are **never** auto-rotated. `override_generate` returns an
  advisory + secrets-migration template; `config_verify` marks them `advisory`. We do not pretend
  they are fixed.
- The original repo is read-only; every write happens in a per-run fixture copy
  (`traces/<run-id>/fixture/`).

## Layout

```
src/
  run-agent.mjs            # entry: env-check→fixture→session→bus→prompt→report
  env-check.mjs            # API key / Docker / compose / model probe
  events/bus.mjs           # AgentSessionEvent → ToolEvent mapping + fanout
  tools/{core,registry,static-tools,runtime-tools}.mjs
  knowledge/{rules,signatures}.mjs
  trace/recorder.mjs       # trace.jsonl/md + report.md (deterministic)
  guard/budget.mjs         # R8 convergence guard
  prompts/system.md
  dashboard/{server.mjs, public/index.html}
harness/fault-driver.mjs   # Phase 2 fault injection (harness, not agent)
pi-extension/              # Phase 2 V2 (pi-web-ui)
tests/{unit,contract,replay,e2e}/
traces/<run-id>/           # trace.jsonl/md + report.md + fixture/
```
