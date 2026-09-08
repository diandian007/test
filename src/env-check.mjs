// env-check: probe API key, Docker daemon, compose form, model selection.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getModel } from '@earendil-works/pi-ai/compat';

export const DEFAULT_MODEL = 'claude-sonnet-5';
export const DEFAULT_PROVIDER = 'anthropic';
export const DEFAULT_THINKING = 'medium';

export function envCheck() {
  // --- API key (also accept ANTHROPIC_AUTH_TOKEN via Bearer, paired with ANTHROPIC_BASE_URL) ---
  const envKey = process.env.ANTHROPIC_API_KEY;
  const envAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const piAuthPath = join(homedir(), '.pi', 'agent', 'auth.json');
  let piAuth = null;
  if (existsSync(piAuthPath)) {
    try { piAuth = JSON.parse(readFileSync(piAuthPath, 'utf8')); } catch { /* ignore */ }
  }
  const hasKey = Boolean(envKey || envAuthToken || (piAuth && (piAuth.anthropic || piAuth['anthropic/claude'] || piAuth.default)));

  // --- Docker daemon ---
  let dockerOk = false, dockerHint = '';
  try {
    const r = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 4000 });
    dockerOk = r.status === 0 && !!r.stdout.trim();
  } catch { /* ignore */ }
  if (!dockerOk) dockerHint = 'brew install colima && colima start --cpu 2 --memory 4';

  // --- compose form ---
  let composeBin = null, composeForm = 'none';
  try {
    const r = spawnSync('docker-compose', ['version', '--short'], { encoding: 'utf8', timeout: 4000 });
    if (r.status === 0 && r.stdout.trim()) { composeBin = 'docker-compose'; composeForm = `standalone ${r.stdout.trim()}`; }
  } catch { /* ignore */ }
  if (!composeBin) {
    try {
      const r = spawnSync('docker', ['compose', 'version', '--short'], { encoding: 'utf8', timeout: 4000 });
      if (r.status === 0 && r.stdout.trim()) { composeBin = 'docker compose'; composeForm = `plugin ${r.stdout.trim()}`; }
    } catch { /* ignore */ }
  }

  // --- model ---
  const modelId = process.env.SRE_MODEL_ID || DEFAULT_MODEL;
  const provider = process.env.SRE_PROVIDER || DEFAULT_PROVIDER;
  let model = null;
  try { model = getModel(provider, modelId); } catch { model = null; }
  const thinking = process.env.SRE_THINKING || DEFAULT_THINKING;

  return {
    apiKey: { ready: hasKey, source: envKey ? 'ANTHROPIC_API_KEY' : (envAuthToken ? 'ANTHROPIC_AUTH_TOKEN' : (piAuth ? '~/.pi/agent/auth.json' : 'missing')) },
    docker: { available: dockerOk, hint: dockerHint },
    compose: { bin: composeBin, form: composeForm },
    model: { provider, id: modelId, available: !!model, thinking },
    phase: dockerOk ? 'runtime (L2) possible' : 'static (L1) only — no Docker daemon',
  };
}

export function formatEnvCheck(e) {
  const L = [];
  L.push('=== NetBox SRE Agent — env-check ===');
  L.push(`API key : ${e.apiKey.ready ? '✓ ready' : '✗ missing'} (${e.apiKey.source})`);
  L.push(`Docker  : ${e.docker.available ? '✓ available' : '✗ unavailable'}${e.docker.hint ? ' → ' + e.docker.hint : ''}`);
  L.push(`Compose : ${e.compose.bin ? '✓ ' + e.compose.form : '✗ none (standalone docker-compose recommended; plugin also accepted)'}`);
  L.push(`Model   : ${e.model.provider}/${e.model.id} (thinking=${e.model.thinking})${e.model.available ? ' ✓' : ' ✗ not in catalog'}`);
  L.push(`Phase   : ${e.phase}`);
  return L.join('\n');
}
