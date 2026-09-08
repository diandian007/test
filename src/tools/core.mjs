// Pure tool implementations, decoupled from pi SDK registration.
// Each tool: { name, label, description, parameters(TypeBox), promptSnippet, execute(ctx, args) }
// execute returns { ok:true, data } | { ok:false, error, hint } (structured; never throws for bad args).

import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, join, sep } from 'node:path';
import { dump as yamlDump, load as yamlLoad } from 'js-yaml';
import { Type } from 'typebox';
import { buildScanContext, scan, explainRule, fixesForRules, RULES } from '../knowledge/rules.mjs';
import { matchSignatures, SIGNATURES } from '../knowledge/signatures.mjs';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
export function safePath(fixtureRoot, p) {
  if (typeof p !== 'string' || !p) {
    return { ok: false, error: 'invalid_path', hint: 'path must be a non-empty string' };
  }
  const root = resolve(fixtureRoot);
  const target = resolve(root, p);
  const rel = relative(root, target);
  // reject traversal outside fixture root
  if (rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel) || target === root && p.includes('..')) {
    return { ok: false, error: 'path_escape', hint: `path escapes fixture root: ${p}` };
  }
  if (rel.startsWith('..')) {
    return { ok: false, error: 'path_escape', hint: `path escapes fixture root: ${p}` };
  }
  return { ok: true, target };
}

function ok(data) {
  return { ok: true, data };
}
function err(error, hint) {
  return { ok: false, error, hint };
}

// deterministic json serialization helper
function stable(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Phase 1 — static tools
// ---------------------------------------------------------------------------
export const STATIC_TOOLS = [
  {
    name: 'repo_scan',
    label: 'Repository Scan',
    description: 'Scan the fixture for all static misconfiguration findings (L1). Returns repo summary + Finding list. No Docker needed.',
    promptSnippet: 'repo_scan({scope?}) — discover all static findings + repo summary (VERSION, image tag, services).',
    parameters: Type.Object({
      scope: Type.Optional(Type.Union([Type.Literal('static'), Type.Literal('all')])),
    }),
    execute(ctx, args = {}) {
      const root = ctx.fixtureRoot;
      if (!root || !existsSync(root)) return err('no_fixture', 'fixture root not available');
      const sctx = buildScanContext(root, { withOverride: false });
      const findings = scan(sctx, {});
      return ok({
        repo: {
          version: sctx.version,
          image_tag: sctx.imageTag,
          services: sctx.services,
        },
        findings,
        finding_count: findings.length,
        rule_count: RULES.length,
      });
    },
  },
  {
    name: 'rule_explain',
    label: 'Rule Explanation',
    description: 'Explain a static rule: mechanism, impact, remediation path, auto_fixable flag, fix_hint. Use after repo_scan to understand a finding.',
    promptSnippet: 'rule_explain({rule_id}) — mechanism/impact/remediation/auto_fixable for a rule.',
    parameters: Type.Object({ rule_id: Type.String() }),
    execute(ctx, args = {}) {
      const info = explainRule(args.rule_id);
      if (!info) return err('unknown_rule', `no rule with id ${args.rule_id}`);
      return ok(info);
    },
  },
  {
    name: 'file_read',
    label: 'File Read',
    description: 'Read a file from the fixture (evidence gathering). Path is resolved and confined to the fixture root — traversal (../) is rejected. Optional line range.',
    promptSnippet: 'file_read({path,start_line?,end_line?}) — fixture-confined file read for evidence.',
    parameters: Type.Object({
      path: Type.String(),
      start_line: Type.Optional(Type.Integer({ minimum: 1 })),
      end_line: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    execute(ctx, args = {}) {
      const sp = safePath(ctx.fixtureRoot, args.path);
      if (!sp.ok) return err(sp.error, sp.hint);
      if (!existsSync(sp.target)) return err('not_found', `file not found: ${args.path}`);
      const content = readFileSync(sp.target, 'utf8');
      const lines = content.split('\n');
      const start = args.start_line || 1;
      const end = args.end_line || lines.length;
      const slice = lines.slice(start - 1, end).join('\n');
      return ok({
        path: args.path,
        start_line: start,
        end_line: end,
        total_lines: lines.length,
        content: slice,
      });
    },
  },
  {
    name: 'override_generate',
    label: 'Override Generate',
    description: 'Generate a docker-compose.override.yml fragment applying auto-fixable rules. Idempotent (same input → identical bytes). Secret/credential rules are NOT auto-fixable and return advisory + secrets migration template. Writes to fixture/docker-compose.override.yml.',
    promptSnippet: 'override_generate({fixes:[{rule_id}],reason}) — idempotent override for auto-fixable rules.',
    parameters: Type.Object({
      fixes: Type.Array(Type.Object({ rule_id: Type.String() })),
      reason: Type.String(),
    }),
    execute(ctx, args = {}) {
      const root = ctx.fixtureRoot;
      const overridePath = join(root, 'docker-compose.override.yml');
      const examplePath = join(root, 'docker-compose.override.yml.example');

      // base: existing override > example > minimal
      let base = { services: { netbox: {} } };
      if (existsSync(overridePath)) {
        try { base = yamlLoad(readFileSync(overridePath, 'utf8')) || base; } catch { /* keep base */ }
      } else if (existsSync(examplePath)) {
        try { base = yamlLoad(readFileSync(examplePath, 'utf8')) || base; } catch { /* keep base */ }
      }
      base.services = base.services || {};
      base.services.netbox = base.services.netbox || {};
      if (Array.isArray(base.services.netbox) || typeof base.services.netbox !== 'object') {
        base.services.netbox = {};
      }

      const requested = (args.fixes || []).map((f) => f.rule_id);
      const fixes = fixesForRules(requested); // only auto_fixable rules contribute
      const nonFixable = requested.filter((id) => {
        const r = RULES.find((x) => x.id === id);
        return !r || !r.auto_fixable;
      });

      // merge environment (map form for determinism)
      const env = {};
      const existingEnv = base.services.netbox.environment;
      if (existingEnv && !Array.isArray(existingEnv) && typeof existingEnv === 'object') {
        for (const [k, v] of Object.entries(existingEnv)) env[k] = String(v);
      }
      for (const [k, v] of Object.entries(fixes)) env[k] = v;
      base.services.netbox.environment = env;

      // deterministic dump
      const out = yamlDump(base, { sortKeys: true, lineWidth: -1, noRefs: true });
      writeFileSync(overridePath, out);

      // advisory for non-auto-fixable / secret rules
      const advisory = nonFixable.map((id) => {
        const r = RULES.find((x) => x.id === id);
        return {
          rule_id: id,
          auto_fixable: false,
          reason: r ? 'credential/secret cannot be auto-rotated' : 'unknown rule',
          fix_hint: r ? r.fix_hint : 'unknown rule',
          secrets_migration: isSecretRule(id)
            ? {
                file: 'secrets/' + secretFileName(id),
                note: `Add to compose: secrets: [${secretFileName(id)}]; mount via _read_secret("${secretName(id)}").`,
              }
            : undefined,
        };
      });

      return ok({
        written: 'docker-compose.override.yml',
        applied_fixes: fixes,
        advisory,
        reason: args.reason,
        bytes: Buffer.byteLength(out),
      });
    },
  },
  {
    name: 'config_verify',
    label: 'Config Verify',
    description: 'Re-scan all rules against the fixture (with any applied override) and emit before/after. Auto-fixable findings fixed by the override show status=fixed. CRITICAL secrets show status=advisory (honest boundary).',
    promptSnippet: 'config_verify({}) — before/after + resolved/remaining/advisory summary.',
    parameters: Type.Object({}),
    execute(ctx, args = {}) {
      const root = ctx.fixtureRoot;
      const ctxBefore = buildScanContext(root, { withOverride: false });
      const ctxAfter = buildScanContext(root, { withOverride: true });
      const before = scan(ctxBefore, {});
      const after = scan(ctxAfter, {});

      // after instance keys (auto_fixable only) — present means still open
      const afterAutoKeys = new Set(
        after.filter((f) => f.auto_fixable).map((f) => f.rule_id + '::' + f.instance_key)
      );

      const resolved = [];
      const remaining = [];
      const advisory = [];
      for (const f of before) {
        if (!f.auto_fixable) {
          advisory.push({ ...f, status: 'advisory' });
        } else if (afterAutoKeys.has(f.rule_id + '::' + f.instance_key)) {
          remaining.push({ ...f, status: 'open' });
        } else {
          resolved.push({ ...f, status: 'fixed' });
        }
      }

      return ok({
        before: { finding_count: before.length, findings: before },
        after: { finding_count: after.length, findings: after },
        summary: {
          resolved: resolved.map((f) => ({ id: f.id, rule_id: f.rule_id, instance_key: f.instance_key, severity: f.severity })),
          remaining: remaining.map((f) => ({ id: f.id, rule_id: f.rule_id, instance_key: f.instance_key, severity: f.severity })),
          advisory: advisory.map((f) => ({ id: f.id, rule_id: f.rule_id, instance_key: f.instance_key, severity: f.severity })),
        },
      });
    },
  },
  {
    name: 'fault_classify',
    label: 'Fault Classify',
    description: 'Match evidence text against the runtime fault signature library. Returns CANDIDATES (signature_id + evidence line + confidence + next_probe_hint) — NOT a final verdict. The agent must correlate candidates with L1/L2 evidence to reach a root cause.',
    promptSnippet: 'fault_classify({evidence}) — candidate signatures + next_probe_hint (no final verdict).',
    parameters: Type.Object({ evidence: Type.String() }),
    execute(ctx, args = {}) {
      const candidates = matchSignatures(args.evidence || '', {});
      return ok({
        candidates,
        candidate_count: candidates.length,
        note: 'Candidates only — correlate with L1 config / L2 status before concluding.',
      });
    },
  },
];

// ---------------------------------------------------------------------------
// Phase 2 — runtime tools (Phase 1 = degraded stubs; Phase 2 swaps execute())
// ---------------------------------------------------------------------------
export const RUNTIME_TOOLS = [
  {
    name: 'stack_status',
    label: 'Stack Status',
    description: 'L2: report status of all five compose services + healthcheck detail + State.OOMKilled / restarts (docker-compose ps + docker inspect).',
    promptSnippet: 'stack_status({}) — five-service status + healthcheck + OOM/restart counts.',
    parameters: Type.Object({}),
    execute(ctx, args = {}) {
      return dockerUnavailable('stack_status', 'Run: brew install colima && colima start --cpu 2 --memory 4');
    },
  },
  {
    name: 'container_logs',
    label: 'Container Logs',
    description: 'L2: fetch container logs for a service + inline deterministic signature hits collected during scrape.',
    promptSnippet: 'container_logs({service,tail?,since?}) — logs + inline signature_hits.',
    parameters: Type.Object({
      service: Type.String(),
      tail: Type.Optional(Type.Integer({ minimum: 1 })),
      since: Type.Optional(Type.String()),
    }),
    execute(ctx, args = {}) {
      return dockerUnavailable('container_logs');
    },
  },
  {
    name: 'http_probe',
    label: 'HTTP Probe',
    description: 'L2: HTTP probe (/login/, /api/status/, /metrics) — status code / latency / body snippet. Probes external IP AND localhost to expose ALLOWED_HOSTS faults (healthcheck can pass while external 400s).',
    promptSnippet: 'http_probe({path}) — status/latency/body; external+localhost dual probe.',
    parameters: Type.Object({ path: Type.String() }),
    execute(ctx, args = {}) {
      return dockerUnavailable('http_probe');
    },
  },
  {
    name: 'stack_reapply',
    label: 'Stack Reapply',
    description: 'L2: reload the (corrected) compose stack.',
    promptSnippet: 'stack_reapply({}) — reload compose after override.',
    parameters: Type.Object({}),
    execute(ctx, args = {}) {
      return dockerUnavailable('stack_reapply');
    },
  },
  {
    name: 'service_restart',
    label: 'Service Restart',
    description: 'L2: restart a single service.',
    promptSnippet: 'service_restart({service}) — restart one service.',
    parameters: Type.Object({ service: Type.String() }),
    execute(ctx, args = {}) {
      return dockerUnavailable('service_restart');
    },
  },
  {
    name: 'health_verify',
    label: 'Health Verify',
    description: 'L2: full-stack re-probe + DETERMINISTIC recovery assertion (the LLM does not declare recovery on its own).',
    promptSnippet: 'health_verify({}) — deterministic recovery assertion.',
    parameters: Type.Object({}),
    execute(ctx, args = {}) {
      return dockerUnavailable('health_verify');
    },
  },
];

function dockerUnavailable(tool, hint) {
  return {
    ok: false,
    error: 'docker_unavailable',
    degraded: true,
    tool,
    hint: hint || 'Start colima: brew install colima && colima start --cpu 2 --memory 4',
    guidance: 'No Docker daemon detected. L2 runtime tools are unavailable in Phase 1. Continue with L1 static analysis (repo_scan, file_read, override_generate, config_verify).',
  };
}

export const ALL_CORE_TOOLS = [...STATIC_TOOLS, ...RUNTIME_TOOLS];

export function getCoreTool(name) {
  return ALL_CORE_TOOLS.find((t) => t.name === name) || null;
}

// secret-rule helpers for override advisory
function isSecretRule(id) {
  return id && id.startsWith('SECRET-');
}
function secretFileName(id) {
  const map = {
    'SECRET-001': 'secret_key',
    'SECRET-002': 'db_password',
    'SECRET-003': 'redis_password',
    'SECRET-004': 'api_token_pepper_1',
  };
  return map[id] || id.toLowerCase();
}
function secretName(id) {
  const map = {
    'SECRET-001': 'secret_key',
    'SECRET-002': 'db_password',
    'SECRET-003': 'redis_password',
    'SECRET-004': 'api_token_pepper_1',
  };
  return map[id] || id.toLowerCase();
}
