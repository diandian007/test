// PHASE 2 — harness fault driver (skeleton).
// This is NOT an Agent tool. It is invoked by the demo harness to inject faults
// into the running compose stack BEFORE the agent probes it, then clean up after.
// Phase 1 ships only the interface; Phase 2 fills in the implementations.
//
// Why harness (not an agent tool): if the agent could inject faults itself, it
// would be "fixing what it just broke" — a self-fulfilling loop. The agent's job
// starts from "the stack is in some state" and it must probe to discover it.

export const FAULTS = [
  'db_auth_mismatch',
  'redis_auth_mismatch',
  'db_host_unresolvable',
  'dependency_killed',
  'cache_offline',
  'allowed_hosts_reject',
  'healthcheck_start_period',
  'image_version_mismatch',
  'secret_key_invalid',
];

/**
 * Inject a fault into the fixture (L1 config mutation) or the running stack (L2).
 * Phase 2: implement per-fault logic. Phase 1: throws not-implemented.
 * @param {{fixtureDir?:string, stackDir?:string}} ctx
 * @param {string} fault - one of FAULTS
 */
export async function fault_inject(ctx, fault) {
  if (!FAULTS.includes(fault)) throw new Error(`unknown fault: ${fault}`);
  throw new Error(`fault_inject('${fault}') not implemented in Phase 1 — see spec §6.2`);
}

/**
 * Clean up a fault: restore the fixture / stack to a known-good state.
 * Must be re-entrant and leave no residue (containers/volumes/fixture diffs).
 */
export async function cleanup(ctx, fault) {
  if (!FAULTS.includes(fault)) throw new Error(`unknown fault: ${fault}`);
  throw new Error(`cleanup('${fault}') not implemented in Phase 1`);
}

// Phase 2 implementation outline (per spec §6.2):
//  - db_auth_mismatch:        fixture write wrong DB_PASSWORD → logs signature SIG-CRED-DB-AUTH
//  - redis_auth_mismatch:     fixture write wrong REDIS_PASSWORD → logs+status, SIG-CRED-REDIS-WRONGPASS
//  - db_host_unresolvable:    fixture write wrong DB_HOST → logs, SIG-NET-HOST-UNRESOLVABLE
//  - dependency_killed:       docker-compose stop postgres → status+probe, dependency
//  - cache_offline:           docker-compose stop redis-cache → logs+probe, dependency (degraded)
//  - allowed_hosts_reject:    fixture set ALLOWED_HOSTS mismatch → probe (REQUIRED), SIG-APP-DISALLOWED-HOST
//  - healthcheck_start_period: start_period 5s → status+logs, SIG-ORCH-START-PERIOD (NOT a restart)
//  - image_version_mismatch:  compose tag ≠ VERSION → status+logs+file_read (L1↔L2 cross-layer)
//  - secret_key_invalid:      fixture blank/short SECRET_KEY → logs, SIG-APP-SECRETKEY-INVALID
