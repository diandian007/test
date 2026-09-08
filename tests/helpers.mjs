// Shared test helpers: copy the golden repo fixture into a temp dir.
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// tests/ -> project root -> netbox-docker (submodule)
export const REPO_ROOT = join(__dirname, '..', 'netbox-docker');

export function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'nb-sre-'));
  cpSync(REPO_ROOT, dir, { recursive: true });
  return dir;
}

export function cleanupFixture(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
