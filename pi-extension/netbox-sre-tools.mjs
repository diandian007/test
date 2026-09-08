// PHASE 2 (V2 optional) — pi extension wrapping the SAME core tools via
// pi.registerTool(), driven by pi-web-ui's own in-process session.
// Same core implementations as src/tools/core.mjs — single source of truth.
// Phase 1 ships the stub; Phase 2 wires registerTool for the 12 tools.
//
// Usage (Phase 2): place at .pi/extensions/netbox-sre-tools.mjs, then
//   npx pi-web-ui --cwd <workspace>
//
// Per spec §9 V2: this is a SEPARATE run path (pi-web-ui owns the session);
// it is not a second view of a V1 run. Demo-only, not a hard acceptance gate.

// import { STATIC_TOOLS, RUNTIME_TOOLS } from '../src/tools/core.mjs';
// export default function ({ pi }) {
//   for (const tool of [...STATIC_TOOLS, ...RUNTIME_TOOLS]) {
//     pi.registerTool({ name: tool.name, description: tool.description, parameters: tool.parameters, execute: tool.execute });
//   }
// }

export default function () {
  // Phase 1: no-op stub.
}
