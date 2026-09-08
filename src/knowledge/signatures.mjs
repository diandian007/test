// Runtime fault signatures (spec §6.3). Deterministic, unit-testable.
// Each signature: { id, fault_domain, applies_to, pattern|predicate, root_cause_layer, confidence, next_probe_hint, remediation_hint, examples:{pos,neg} }
// root_cause_layer ∈ credential|network|dependency|app_config|version|migration|orchestration|resource

export const SIGNATURES = [
  {
    id: 'SIG-CRED-DB-AUTH',
    fault_domain: 'credential',
    applies_to: 'log',
    pattern: /password authentication failed for user/i,
    root_cause_layer: 'credential',
    confidence: 0.95,
    next_probe_hint: 'file_read env/netbox.env DB_PASSWORD vs env/postgres.env POSTGRES_PASSWORD; trace via configuration.py:75',
    remediation_hint: 'Align DB_PASSWORD (netbox) with POSTGRES_PASSWORD (postgres service); both must match the actual DB user.',
    examples: {
      pos: 'FATAL: password authentication failed for user "netbox"',
      neg: 'database system is ready to accept connections',
    },
  },
  {
    id: 'SIG-CRED-REDIS-WRONGPASS',
    fault_domain: 'credential',
    applies_to: 'log',
    pattern: /WRONGPASS invalid username-password pair/i,
    root_cause_layer: 'credential',
    confidence: 0.95,
    next_probe_hint: 'Compare REDIS_PASSWORD (redis.env) vs REDIS_CACHE_PASSWORD (redis-cache.env) vs netbox REDIS_*PASSWORD; valkey requires $$ escaping in compose',
    remediation_hint: 'Set matching Redis passwords across compose env_file and netbox REDIS/REDIS_CACHE config; mind $$ escaping in compose command.',
    examples: {
      pos: 'WRONGPASS invalid username-password pair',
      neg: 'Ready to accept connections',
    },
  },
  {
    id: 'SIG-NET-HOST-UNRESOLVABLE',
    fault_domain: 'network',
    applies_to: 'log',
    pattern: /could not translate host name .+ to address/i,
    root_cause_layer: 'network',
    confidence: 0.9,
    next_probe_hint: 'Check DB_HOST / REDIS_HOST / REDIS_CACHE_HOST in env/netbox.env; verify compose service names + DNS',
    remediation_hint: 'Set the host to the compose service name (e.g. postgres, redis, redis-cache) or a resolvable DNS name.',
    examples: {
      pos: 'could not translate host name "postgrs" to address: Name or service not known',
      neg: 'connection refused',
    },
  },
  {
    id: 'SIG-APP-DISALLOWED-HOST',
    fault_domain: 'app_config',
    applies_to: 'probe',
    pattern: /DisallowedHost|Invalid HTTP_HOST header/i,
    root_cause_layer: 'app_config',
    confidence: 0.9,
    next_probe_hint: 'Check ALLOWED_HOSTS in env/netbox.env; note configuration.py:64-67 force-appends localhost — probe via external IP AND localhost to expose this',
    remediation_hint: 'Set ALLOWED_HOSTS to the host header actually presented to netbox (or the correct FQDN).',
    examples: {
      pos: 'DisallowedHost: Invalid HTTP_HOST header',
      neg: '200 OK',
    },
  },
  {
    id: 'SIG-APP-SECRETKEY-INVALID',
    fault_domain: 'app_config',
    applies_to: 'log',
    pattern: /SECRET_KEY.{0,40}(at least 50 characters|ImproperlyConfigured)|ImproperlyConfigured.{0,40}SECRET_KEY/i,
    root_cause_layer: 'app_config',
    confidence: 0.85,
    next_probe_hint: 'Check SECRET_KEY length/value in env/netbox.env; empty or <50 chars fails Django startup',
    remediation_hint: 'Provision a SECRET_KEY of at least 50 mixed characters (ideally via Docker secret).',
    examples: {
      pos: "ImproperlyConfigured: The SECRET_KEY setting must not be empty / at least 50 characters",
      neg: 'SECRET_KEY loaded',
    },
  },
  {
    id: 'SIG-DEP-DB-NOT-READY',
    fault_domain: 'dependency',
    applies_to: 'log',
    pattern: /❌ Waited .+ for the DB to become ready/i,
    root_cause_layer: 'dependency',
    confidence: 0.85,
    next_probe_hint: 'Check stack_status for postgres health; DB not ready within entrypoint wait window',
    remediation_hint: 'Ensure postgres is healthy before netbox starts; raise start_period or fix DB startup (migrations/creds).',
    examples: {
      pos: '❌ Waited 60s for the DB to become ready',
      neg: '✅ DB is ready',
    },
  },
  {
    id: 'SIG-MIGRATION-ERROR',
    fault_domain: 'migration',
    applies_to: 'log',
    pattern: /django\.db\.migrations\.exceptions/i,
    root_cause_layer: 'migration',
    confidence: 0.85,
    next_probe_hint: 'Inspect migration logs; check image VERSION ↔ tag compatibility (image_version_mismatch path)',
    remediation_hint: 'Resolve migration error (version mismatch, missing migration, incompatible schema).',
    examples: {
      pos: 'django.db.migrations.exceptions.InconsistentMigrationHistory',
      neg: 'No migrations to apply',
    },
  },
  {
    id: 'SIG-RES-OOMKILLED',
    fault_domain: 'resource',
    applies_to: 'inspect',
    pattern: /OOMKilled["'\s:=]*\s*true/i,
    root_cause_layer: 'resource',
    confidence: 0.9,
    next_probe_hint: 'docker inspect <container> State.OOMKilled; check memory limits in compose',
    remediation_hint: 'Increase memory limit or reduce worker count (GRANIAN_WORKERS).',
    examples: {
      pos: 'OOMKilled=true',
      neg: 'OOMKilled=false',
    },
  },
  {
    id: 'SIG-RES-DISK-FULL',
    fault_domain: 'resource',
    applies_to: 'log',
    pattern: /No space left on device/i,
    root_cause_layer: 'resource',
    confidence: 0.9,
    next_probe_hint: 'Check host/volume disk usage; compose volumes',
    remediation_hint: 'Free disk space or expand the volume.',
    examples: {
      pos: 'write failed: No space left on device',
      neg: 'write succeeded',
    },
  },
  {
    // composite signature: healthcheck failing while migrations still running
    id: 'SIG-ORCH-START-PERIOD',
    fault_domain: 'orchestration',
    applies_to: 'status',
    predicate(evidence) {
      const e = String(evidence);
      const healthFail = /unhealthy|starting|health check failed/i.test(e);
      const migrating = /migrat|applying|Running migrations/i.test(e);
      return healthFail && migrating;
    },
    root_cause_layer: 'orchestration',
    confidence: 0.75,
    next_probe_hint: 'Check healthcheck start_period in docker-compose.yml (netbox default 90s); migrations still running during startup',
    remediation_hint: 'Raise healthcheck start_period (NOT a restart) — the service is healthy-but-starting; restart loops will make it worse.',
    examples: {
      pos: 'healthcheck: starting\nRunning netbox migrations 0001_initial...',
      neg: 'healthy\nno migrations to apply',
    },
  },
];

// Match evidence against signatures. Returns candidate list (NOT a final verdict).
// @param {string|object} evidence - text (log) or structured status/inspect blob
// @param {object} [opts] - { appliesTo?: 'log'|'status'|'probe'|'inspect' }
export function matchSignatures(evidence, opts = {}) {
  const text = typeof evidence === 'string' ? evidence : JSON.stringify(evidence);
  const out = [];
  for (const sig of SIGNATURES) {
    if (opts.appliesTo && sig.applies_to !== opts.appliesTo) continue;
    let hit = false;
    if (sig.predicate) {
      hit = sig.predicate(text);
    } else if (sig.pattern) {
      const m = text.match(sig.pattern);
      if (m) {
        out.push(_candidate(sig, m[0]));
        continue;
      }
    }
    if (hit) out.push(_candidate(sig, text.slice(0, 120)));
  }
  return out;
}

function _candidate(sig, matchedText) {
  const idx = String(matchedText).slice(0, 100);
  return {
    signature_id: sig.id,
    fault_domain: sig.fault_domain,
    root_cause_layer: sig.root_cause_layer,
    confidence: sig.confidence,
    evidence_line: idx,
    applies_to: sig.applies_to,
    next_probe_hint: sig.next_probe_hint,
    remediation_hint: sig.remediation_hint,
  };
}

export function getSignature(id) {
  return SIGNATURES.find((s) => s.id === id) || null;
}
