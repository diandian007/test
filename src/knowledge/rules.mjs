// 14 static rules for netbox-docker L1 analysis.
// Every value/default/line below was verified against the real repo at v5.1.0:
//   configuration/configuration.py, env/*.env, docker-compose.yml, VERSION

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { load as parseYaml } from 'js-yaml';

// ---------------------------------------------------------------------------
// configuration.py defaults (file:line verified against v5.1.0)
// ---------------------------------------------------------------------------
const CFG = 'configuration/configuration.py';
export const CONFIG_DEFAULTS = {
  ALLOWED_HOSTS: { default: '*', line: 64, file: CFG },
  DB_SSLMODE: { default: 'prefer', line: 79, file: CFG },
  REDIS_SSL: { default: 'False', line: 103, file: CFG }, // tasks
  REDIS_CACHE_SSL: { default: 'False', line: 120, file: CFG }, // caching (falls back to REDIS_SSL)
  CORS_ORIGIN_ALLOW_ALL: { default: 'False', line: 187, file: CFG },
  SECURE_HSTS_SECONDS: { default: 0, line: 385, file: CFG },
  SECURE_SSL_REDIRECT: { default: 'False', line: 388, file: CFG },
  METRICS_ENABLED: { default: 'False', line: 280, file: CFG },
};

// ---------------------------------------------------------------------------
// env file parsing
// ---------------------------------------------------------------------------
export function parseEnvFile(content) {
  const lines = String(content).split('\n');
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1);
    // strip surrounding quotes (keep inner content)
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    entries.push({ key, value: value, line: i + 1, raw: trimmed });
  }
  return entries;
}

function readEnvFile(root, rel) {
  const p = join(root, rel);
  if (!existsSync(p)) return [];
  return parseEnvFile(readFileSync(p, 'utf8'));
}

function envMap(entries) {
  const m = {};
  for (const e of entries) m[e.key] = e;
  return m;
}

// ---------------------------------------------------------------------------
// scan context
// ---------------------------------------------------------------------------
export function buildScanContext(fixtureRoot, opts = {}) {
  const { withOverride = true } = opts;
  const root = resolve(fixtureRoot);

  // VERSION
  let version = '';
  const versionPath = join(root, 'VERSION');
  if (existsSync(versionPath)) version = readFileSync(versionPath, 'utf8').trim();

  // docker-compose.yml
  const composePath = join(root, 'docker-compose.yml');
  let compose = {};
  if (existsSync(composePath)) {
    try {
      compose = parseYaml(readFileSync(composePath, 'utf8')) || {};
    } catch {
      compose = {};
    }
  }
  const services = compose.services ? Object.keys(compose.services) : [];
  const netboxImage = compose?.services?.netbox?.image || '';
  // extract tag from image "docker.io/netboxcommunity/netbox:${VERSION-v4.7-5.1.0}"
  let imageTag = '';
  const tagMatch = netboxImage.match(/:([^/]+)$/);
  if (tagMatch) imageTag = tagMatch[1];

  // override (may not exist); skipped entirely when withOverride=false
  const overridePath = join(root, 'docker-compose.override.yml');
  let override = null;
  if (withOverride && existsSync(overridePath)) {
    try {
      override = parseYaml(readFileSync(overridePath, 'utf8')) || null;
    } catch {
      override = null;
    }
  }

  // env files
  const files = {
    'env/netbox.env': readEnvFile(root, 'env/netbox.env'),
    'env/postgres.env': readEnvFile(root, 'env/postgres.env'),
    'env/redis.env': readEnvFile(root, 'env/redis.env'),
    'env/redis-cache.env': readEnvFile(root, 'env/redis-cache.env'),
  };

  // effective netbox env = netbox.env entries + override environment (override wins)
  const netboxBase = envMap(files['env/netbox.env']);
  const overrideEnv = override?.services?.netbox?.environment || {};
  // environment may be a map or a list of "KEY=VAL"
  const overrideMap = {};
  if (Array.isArray(overrideEnv)) {
    for (const item of overrideEnv) {
      const [k, ...rest] = String(item).split('=');
      overrideMap[k.trim()] = rest.join('=');
    }
  } else if (overrideEnv && typeof overrideEnv === 'object') {
    for (const [k, v] of Object.entries(overrideEnv)) overrideMap[k] = String(v);
  }
  const netboxEffective = { ...netboxBase };
  for (const [k, v] of Object.entries(overrideMap)) {
    netboxEffective[k] = { key: k, value: v, line: 0, raw: `${k}=${v}`, fromOverride: true };
  }

  return {
    fixtureRoot: root,
    version,
    imageTag,
    services,
    compose,
    override,
    files,
    env: {
      netbox: netboxEffective,
      postgres: envMap(files['env/postgres.env']),
      redis: envMap(files['env/redis.env']),
      'redis-cache': envMap(files['env/redis-cache.env']),
    },
    overrideEnv: overrideMap,
  };
}

// effective value of a netbox env var, falling back to configuration.py default
function effectiveNetbox(ctx, key) {
  if (ctx.env.netbox[key]) {
    return { value: ctx.env.netbox[key].value, source: { file: 'env/netbox.env', line: ctx.env.netbox[key].line, value: ctx.env.netbox[key].raw }, explicit: true };
  }
  const def = CONFIG_DEFAULTS[key];
  if (def) {
    return { value: def.default, source: { file: def.file, line: def.line, value: def.default }, explicit: false };
  }
  return { value: undefined, source: null, explicit: false };
}

function asBool(v) {
  return String(v).toLowerCase() === 'true';
}

// ---------------------------------------------------------------------------
// Finding builder
// ---------------------------------------------------------------------------
let _ctr = 0;
function mkFinding(rule, ctx, partial) {
  _ctr++;
  return {
    id: `F-${String(_ctr).padStart(4, '0')}`,
    rule_id: rule.id,
    severity: rule.severity,
    layer: 'static',
    source: partial.source || { file: '', line: 0, value: '' },
    observed: partial.observed,
    expected: partial.expected,
    evidence: partial.evidence || '',
    auto_fixable: rule.auto_fixable,
    fix_hint: rule.fix_hint,
    instance_key: partial.instance_key || rule.id,
    status: 'open',
  };
}

// reset counter (for deterministic tests)
export function _resetFindingCounter() {
  _ctr = 0;
}

// ---------------------------------------------------------------------------
// 14 rules
// ---------------------------------------------------------------------------
export const RULES = [
  // --- SECRET (plaintext credentials in env files; _read_secret() offers a safe path) ---
  {
    id: 'SECRET-001',
    title: 'SECRET_KEY stored in plaintext',
    category: 'SECRET',
    severity: 'CRITICAL',
    auto_fixable: false,
    fix_hint: 'Move SECRET_KEY to a Docker secret: create secrets/secret_key.txt, add `secrets: [secret_key]` to the netbox service. _read_secret("secret_key") in configuration.py:131 already supports this path but it is unused.',
    knowledge: {
      mechanism: 'SECRET_KEY is a Django cryptographic seed. configuration.py:131 reads it via _read_secret("secret_key", environ.get("SECRET_KEY")) — env fallback is plaintext.',
      impact: 'Compromise of this key enables session forgery, API token forgery, and CSRF bypass. It must never live in a tracked env file.',
      remediation: 'Provision via Docker secret (secrets/secret_key.txt) so _read_secret() reads /run/secrets/secret_key; remove the env var. Never auto-rotate: only emit advisory + migration template.',
    },
    check(ctx) {
      const e = ctx.env.netbox['SECRET_KEY'];
      if (e && e.value) {
        return [mkFinding(this, ctx, {
          source: { file: 'env/netbox.env', line: e.line, value: e.raw },
          observed: 'plaintext SECRET_KEY in env file',
          expected: 'SECRET_KEY provisioned via Docker secret (/run/secrets/secret_key)',
          evidence: `${e.raw.slice(0, 12)}… (value redacted) — env/netbox.env:${e.line}`,
          instance_key: 'secret_key',
        })];
      }
      return [];
    },
  },
  {
    id: 'SECRET-002',
    title: 'DB_PASSWORD stored in plaintext',
    category: 'SECRET',
    severity: 'CRITICAL',
    auto_fixable: false,
    fix_hint: 'Provision DB_PASSWORD via Docker secret (db_password); _read_secret("db_password") in configuration.py:75 supports it. POSTGRES_PASSWORD in env/postgres.env shares the same credential and must also move to a secret.',
    knowledge: {
      mechanism: 'configuration.py:75 reads DB_PASSWORD via _read_secret("db_password", environ.get("DB_PASSWORD")). postgres.env sets POSTGRES_PASSWORD to the same value.',
      impact: 'Database credential exposure; full data access.',
      remediation: 'Docker secret for both db_password (netbox) and the postgres service password.',
    },
    check(ctx) {
      const e = ctx.env.netbox['DB_PASSWORD'];
      if (e && e.value) {
        const pg = ctx.env.postgres['POSTGRES_PASSWORD'];
        const ev = `env/netbox.env:${e.line} DB_PASSWORD` + (pg ? ` (mirrored by env/postgres.env:${pg.line} POSTGRES_PASSWORD)` : '');
        return [mkFinding(this, ctx, {
          source: { file: 'env/netbox.env', line: e.line, value: 'DB_PASSWORD=***' },
          observed: 'plaintext DB_PASSWORD in env file',
          expected: 'DB_PASSWORD provisioned via Docker secret',
          evidence: ev,
          instance_key: 'db_password',
        })];
      }
      return [];
    },
  },
  {
    id: 'SECRET-003',
    title: 'Redis passwords stored in plaintext',
    category: 'SECRET',
    severity: 'HIGH',
    auto_fixable: false,
    fix_hint: 'Provision redis_password and redis_cache_password via Docker secrets; _read_secret() in configuration.py:101 and :116 already support the path.',
    knowledge: {
      mechanism: 'configuration.py:101 (_read_secret redis_password) and :116 (_read_secret redis_cache_password) both fall back to env REDIS_PASSWORD / REDIS_CACHE_PASSWORD. Two distinct services → two instances.',
      impact: 'Cache/task queue credential exposure.',
      remediation: 'Docker secrets for both redis_password and redis_cache_password.',
    },
    check(ctx) {
      const out = [];
      const redisEnv = ctx.env.redis['REDIS_PASSWORD'];
      if (redisEnv && redisEnv.value) {
        out.push(mkFinding(this, ctx, {
          source: { file: 'env/redis.env', line: redisEnv.line, value: redisEnv.raw },
          observed: 'plaintext redis REDIS_PASSWORD',
          expected: 'redis_password via Docker secret',
          evidence: `env/redis.env:${redisEnv.line}`,
          instance_key: 'redis',
        }));
      }
      const cacheEnv = ctx.env['redis-cache']['REDIS_PASSWORD'];
      if (cacheEnv && cacheEnv.value) {
        out.push(mkFinding(this, ctx, {
          source: { file: 'env/redis-cache.env', line: cacheEnv.line, value: cacheEnv.raw },
          observed: 'plaintext redis-cache REDIS_PASSWORD',
          expected: 'redis_cache_password via Docker secret',
          evidence: `env/redis-cache.env:${cacheEnv.line}`,
          instance_key: 'redis-cache',
        }));
      }
      return out;
    },
  },
  {
    id: 'SECRET-004',
    title: 'API_TOKEN_PEPPER stored in plaintext',
    category: 'SECRET',
    severity: 'HIGH',
    auto_fixable: false,
    fix_hint: 'Provision via Docker secret (api_token_pepper_1); _read_secret() in configuration.py:134 supports it.',
    knowledge: {
      mechanism: 'configuration.py:134 reads API_TOKEN_PEPPER_1 via _read_secret("api_token_pepper_1", environ.get(...)).',
      impact: 'Pepper compromise enables API token forgery.',
      remediation: 'Docker secret api_token_pepper_1.',
    },
    check(ctx) {
      const e = ctx.env.netbox['API_TOKEN_PEPPER_1'];
      if (e && e.value) {
        return [mkFinding(this, ctx, {
          source: { file: 'env/netbox.env', line: e.line, value: e.raw },
          observed: 'plaintext API_TOKEN_PEPPER_1',
          expected: 'api_token_pepper_1 via Docker secret',
          evidence: `env/netbox.env:${e.line} (value redacted)`,
          instance_key: 'api_token_pepper',
        })];
      }
      return [];
    },
  },

  // --- NET ---
  {
    id: 'NET-001',
    title: 'CORS_ORIGIN_ALLOW_ALL is True',
    category: 'NET',
    severity: 'HIGH',
    auto_fixable: true,
    fix_hint: 'Set CORS_ORIGIN_ALLOW_ALL=false and define an explicit CORS_ORIGIN_WHITELIST.',
    knowledge: {
      mechanism: 'configuration.py:187 reads CORS_ORIGIN_ALLOW_ALL (default False). netbox.env sets it True, allowing any origin to perform cross-origin requests.',
      impact: 'Cross-origin read theft from browsers on arbitrary origins.',
      remediation: 'Override environment: CORS_ORIGIN_ALLOW_ALL=false; supply CORS_ORIGIN_WHITELIST.',
    },
    fix: { CORS_ORIGIN_ALLOW_ALL: 'false' },
    check(ctx) {
      const v = effectiveNetbox(ctx, 'CORS_ORIGIN_ALLOW_ALL');
      if (asBool(v.value)) {
        return [mkFinding(this, ctx, {
          source: v.source,
          observed: 'CORS_ORIGIN_ALLOW_ALL=True',
          expected: 'false (explicit CORS_ORIGIN_WHITELIST)',
          evidence: v.explicit ? `env/netbox.env:${v.source.line}` : `${v.source.file}:${v.source.line} default`,
          instance_key: 'cors_all',
        })];
      }
      return [];
    },
  },
  {
    id: 'NET-002',
    title: 'ALLOWED_HOSTS defaults to wildcard',
    category: 'NET',
    severity: 'MEDIUM',
    auto_fixable: false,
    fix_hint: 'Requires your domain. Set ALLOWED_HOSTS to an explicit FQDN list (e.g. netbox.example.com). Not auto-fixable because the value is user-specific.',
    knowledge: {
      mechanism: 'configuration.py:64 reads ALLOWED_HOSTS (default "*"). Absent in env → wildcard. Lines 65-67 force-append localhost for health checks.',
      impact: 'Host-header attacks / phishing on arbitrary hostnames.',
      remediation: 'Set ALLOWED_HOSTS to your real FQDN(s).',
    },
    check(ctx) {
      const v = effectiveNetbox(ctx, 'ALLOWED_HOSTS');
      if (!v.explicit || v.value === '*' || String(v.value).split(' ').includes('*')) {
        return [mkFinding(this, ctx, {
          source: v.source,
          observed: "ALLOWED_HOSTS = '*' (wildcard)",
          expected: 'explicit FQDN list',
          evidence: `${v.source.file}:${v.source.line} (default '*'; localhost auto-appended for health checks)`,
          instance_key: 'allowed_hosts',
        })];
      }
      return [];
    },
  },
  {
    id: 'NET-003',
    title: 'SECURE_SSL_REDIRECT is False',
    category: 'NET',
    severity: 'MEDIUM',
    auto_fixable: true,
    fix_hint: 'Set SECURE_SSL_REDIRECT=true so non-HTTPS requests redirect to HTTPS.',
    knowledge: {
      mechanism: 'configuration.py:388 reads SECURE_SSL_REDIRECT (default False).',
      impact: 'Sessions/credentials may transit over plain HTTP.',
      remediation: 'Override environment: SECURE_SSL_REDIRECT=true.',
    },
    fix: { SECURE_SSL_REDIRECT: 'true' },
    check(ctx) {
      const v = effectiveNetbox(ctx, 'SECURE_SSL_REDIRECT');
      if (!asBool(v.value)) {
        return [mkFinding(this, ctx, {
          source: v.source,
          observed: 'SECURE_SSL_REDIRECT=False',
          expected: 'true',
          evidence: v.explicit ? `env/netbox.env:${v.source.line}` : `${v.source.file}:${v.source.line} default False`,
          instance_key: 'ssl_redirect',
        })];
      }
      return [];
    },
  },
  {
    id: 'NET-004',
    title: 'HSTS not enabled',
    category: 'NET',
    severity: 'MEDIUM',
    auto_fixable: true,
    fix_hint: 'Set SECURE_HSTS_SECONDS=31536000 (1 year); optionally SECURE_HSTS_INCLUDE_SUBDOMAINS=true.',
    knowledge: {
      mechanism: 'configuration.py:385 reads SECURE_HSTS_SECONDS (default 0 = disabled).',
      impact: 'No HSTS → first-visit SSL downgrade/MITM window.',
      remediation: 'Override environment: SECURE_HSTS_SECONDS=31536000.',
    },
    fix: { SECURE_HSTS_SECONDS: '31536000' },
    check(ctx) {
      const v = effectiveNetbox(ctx, 'SECURE_HSTS_SECONDS');
      if (Number(v.value) === 0 || v.value === undefined) {
        return [mkFinding(this, ctx, {
          source: v.source,
          observed: 'SECURE_HSTS_SECONDS=0 (HSTS disabled)',
          expected: 'non-zero (e.g. 31536000)',
          evidence: v.explicit ? `env/netbox.env:${v.source.line}` : `${v.source.file}:${v.source.line} default 0`,
          instance_key: 'hsts',
        })];
      }
      return [];
    },
  },
  {
    id: 'NET-005',
    title: 'DB_SSLMODE is prefer (not require)',
    category: 'NET',
    severity: 'MEDIUM',
    auto_fixable: true,
    fix_hint: 'Set DB_SSLMODE=require to enforce encrypted DB connections.',
    knowledge: {
      mechanism: 'configuration.py:79 sets DB OPTIONS sslmode = environ.get("DB_SSLMODE", "prefer"). "prefer" allows plaintext fallback.',
      impact: 'Potential plaintext DB traffic on misconfigured peers.',
      remediation: 'Override environment: DB_SSLMODE=require.',
    },
    fix: { DB_SSLMODE: 'require' },
    check(ctx) {
      const v = effectiveNetbox(ctx, 'DB_SSLMODE');
      if (String(v.value).toLowerCase() !== 'require') {
        return [mkFinding(this, ctx, {
          source: v.source,
          observed: `DB_SSLMODE=${v.value}`,
          expected: 'require',
          evidence: v.explicit ? `env/netbox.env:${v.source.line}` : `${v.source.file}:${v.source.line} default 'prefer'`,
          instance_key: 'db_ssl',
        })];
      }
      return [];
    },
  },
  {
    id: 'NET-006',
    title: 'Redis SSL disabled',
    category: 'NET',
    severity: 'MEDIUM',
    auto_fixable: true,
    fix_hint: 'Set REDIS_SSL=true and REDIS_CACHE_SSL=true to require TLS to Redis (two instances: tasks + caching).',
    knowledge: {
      mechanism: 'configuration.py:103 (tasks) and :120 (caching) read REDIS_SSL / REDIS_CACHE_SSL (default False). Two instances.',
      impact: 'Plaintext Redis traffic; credential exposure on the network.',
      remediation: 'Override environment: REDIS_SSL=true, REDIS_CACHE_SSL=true.',
    },
    fix: { REDIS_SSL: 'true', REDIS_CACHE_SSL: 'true' },
    check(ctx) {
      const out = [];
      const tasks = effectiveNetbox(ctx, 'REDIS_SSL');
      if (!asBool(tasks.value)) {
        out.push(mkFinding(this, ctx, {
          source: tasks.source,
          observed: 'REDIS_SSL=False (tasks)',
          expected: 'true',
          evidence: tasks.explicit ? `env/netbox.env:${tasks.source.line}` : `${tasks.source.file}:${tasks.source.line} default False`,
          instance_key: 'redis_ssl_tasks',
        }));
      }
      const cache = effectiveNetbox(ctx, 'REDIS_CACHE_SSL');
      if (!asBool(cache.value)) {
        out.push(mkFinding(this, ctx, {
          source: cache.source,
          observed: 'REDIS_CACHE_SSL=False (caching)',
          expected: 'true',
          evidence: cache.explicit ? `env/netbox.env:${cache.source.line}` : `${cache.source.file}:${cache.source.line} default False`,
          instance_key: 'redis_ssl_cache',
        }));
      }
      return out;
    },
  },

  // --- OBS ---
  {
    id: 'OBS-001',
    title: 'METRICS_ENABLED is false',
    category: 'OBS',
    severity: 'MEDIUM',
    auto_fixable: true,
    fix_hint: 'Set METRICS_ENABLED=true to expose /metrics for observability.',
    knowledge: {
      mechanism: 'configuration.py:280 reads METRICS_ENABLED (default False).',
      impact: 'No Prometheus metrics → blind to latency/error/queue signals.',
      remediation: 'Override environment: METRICS_ENABLED=true.',
    },
    fix: { METRICS_ENABLED: 'true' },
    check(ctx) {
      const v = effectiveNetbox(ctx, 'METRICS_ENABLED');
      if (!asBool(v.value)) {
        return [mkFinding(this, ctx, {
          source: v.source,
          observed: 'METRICS_ENABLED=false',
          expected: 'true',
          evidence: v.explicit ? `env/netbox.env:${v.source.line}` : `${v.source.file}:${v.source.line} default False`,
          instance_key: 'metrics',
        })];
      }
      return [];
    },
  },
  {
    id: 'OBS-002',
    title: 'Email credentials empty / plaintext',
    category: 'OBS',
    severity: 'LOW',
    auto_fixable: false,
    fix_hint: 'Configure a real SMTP server + provision EMAIL_PASSWORD via Docker secret (email_password).',
    knowledge: {
      mechanism: 'netbox.env sets EMAIL_FROM but EMAIL_PASSWORD is empty; EMAIL_SERVER defaults to localhost (configuration.py:203). Email is effectively unconfigured.',
      impact: 'No alert/email delivery; misconfiguration not auto-fixable (needs SMTP details).',
      remediation: 'Provide SMTP settings + secret.',
    },
    check(ctx) {
      const pw = ctx.env.netbox['EMAIL_PASSWORD'];
      const from = ctx.env.netbox['EMAIL_FROM'];
      if ((from && from.value) && (!pw || !pw.value)) {
        return [mkFinding(this, ctx, {
          source: { file: 'env/netbox.env', line: pw ? pw.line : (from ? from.line : 0), value: 'EMAIL_PASSWORD=' },
          observed: 'EMAIL_PASSWORD empty while EMAIL_FROM set',
          expected: 'configured SMTP + secret-backed password',
          evidence: `env/netbox.env:${pw ? pw.line : from.line} EMAIL_PASSWORD empty`,
          instance_key: 'email',
        })];
      }
      return [];
    },
  },

  // --- OPS ---
  {
    id: 'OPS-001',
    title: 'SKIP_SUPERUSER is true',
    category: 'OPS',
    severity: 'INFO',
    auto_fixable: false,
    fix_hint: 'Informational. In production, ensure a superuser is bootstrapped out-of-band (SKIP_SUPERUSER defaults true in the demo image).',
    knowledge: {
      mechanism: 'netbox.env sets SKIP_SUPERUSER=true (demo default), so the entrypoint skips admin creation.',
      impact: 'No automatic superuser; intended for demo. Production must bootstrap separately.',
      remediation: 'Set SKIP_SUPERUSER=false and supply SUPERUSER_* (or bootstrap out-of-band).',
    },
    check(ctx) {
      const e = ctx.env.netbox['SKIP_SUPERUSER'];
      if (e && asBool(e.value)) {
        return [mkFinding(this, ctx, {
          source: { file: 'env/netbox.env', line: e.line, value: e.raw },
          observed: 'SKIP_SUPERUSER=true',
          expected: 'explicit superuser bootstrap in production',
          evidence: `env/netbox.env:${e.line}`,
          instance_key: 'skip_superuser',
        })];
      }
      return [];
    },
  },
  {
    id: 'OPS-002',
    title: 'Redis persistence configuration inconsistent',
    category: 'OPS',
    severity: 'INFO',
    auto_fixable: false,
    fix_hint: 'Informational. redis uses --appendonly yes (AOF) while redis-cache (cache-only) does not. Verify this matches your durability intent.',
    knowledge: {
      mechanism: 'docker-compose.yml: redis command includes `--appendonly yes` (line 54); redis-cache command (line 69) does not. Cache data is ephemeral by design; task queue data is durable.',
      impact: 'Likely intentional (cache vs queue) — flagged for review, not a defect.',
      remediation: 'Confirm intent; no change required if cache is disposable.',
    },
    check(ctx) {
      const redisCmd = ctx.compose?.services?.redis?.command || [];
      const cacheCmd = ctx.compose?.services?.['redis-cache']?.command || [];
      const redisAof = redisCmd.join(' ').includes('--appendonly yes');
      const cacheAof = cacheCmd.join(' ').includes('--appendonly yes');
      if (redisAof && !cacheAof) {
        return [mkFinding(this, ctx, {
          source: { file: 'docker-compose.yml', line: 54, value: 'redis --appendonly yes; redis-cache (none)' },
          observed: 'redis AOF on; redis-cache AOF off',
          expected: 'consistent, intent-verified persistence',
          evidence: 'docker-compose.yml redis command has --appendonly yes; redis-cache does not',
          instance_key: 'redis_persist',
        })];
      }
      return [];
    },
  },
];

// ---------------------------------------------------------------------------
// scan + explain
// ---------------------------------------------------------------------------
export function scan(ctx, { ruleIds } = {}) {
  _resetFindingCounter();
  const out = [];
  for (const rule of RULES) {
    if (ruleIds && !ruleIds.includes(rule.id)) continue;
    const found = rule.check(ctx) || [];
    for (const f of found) out.push(f);
  }
  return out;
}

export function explainRule(ruleId) {
  const rule = RULES.find((r) => r.id === ruleId);
  if (!rule) return null;
  return {
    rule_id: rule.id,
    title: rule.title,
    category: rule.category,
    severity: rule.severity,
    auto_fixable: rule.auto_fixable,
    fix_hint: rule.fix_hint,
    mechanism: rule.knowledge.mechanism,
    impact: rule.knowledge.impact,
    remediation: rule.knowledge.remediation,
    ...(rule.fix ? { fix: rule.fix } : {}),
  };
}

export function getRule(ruleId) {
  return RULES.find((r) => r.id === ruleId) || null;
}

// auto-fixable env overrides for a set of rule_ids (deterministic key order)
export function fixesForRules(ruleIds) {
  const fixes = {};
  for (const r of RULES) {
    if (ruleIds.includes(r.id) && r.fix) Object.assign(fixes, r.fix);
  }
  return fixes;
}
