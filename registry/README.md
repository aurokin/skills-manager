# Agent Capability Registry

`agents.json` is the evidence-backed source of truth for global skill placement,
agent-definition rendering, gating, and read-graph safety. The data is temporal:
refresh evidence when an agent changes its discovery paths or invocation model.

## Main fields

- `directories`: global path templates and deprecation/additional notes.
- `agents.<id>.reads`: confirmed directories in discovery/precedence order.
- `maybeReads`: unconfirmed reads; treated as reads for deny guarantees and
  reported visibility.
- `ownDir`: target used for scoped placement.
- `firstParty`, `dialect`, `symlinks`, `addOnly`: rendering and placement policy.
  `firstParty` means "has a first-party per-dialect frontmatter render channel";
  a renderer dialect without it is deliberate symlink-only (ADR 0016).
- `optIn`: excluded from the default enabled set; machines enable via config
  `agents`/`optInAgents` (hermes, agent variants).
- `unscopedOwnDir`: when enabled, the agent receives unscoped skills in its own
  dir (agents that read neither the shared nor the claude dir; ADR 0016).
- `agentDefDir`, `agentDefDialect`, `agentDefVia`: agent-definition delivery.
- `skillInvocation`: user invocation, model-invocation gate, probe version/date,
  and evidence used by gated placement and drift warnings.
- `evidence`: the source or probe supporting each capability decision.

Keep agent ids stable because catalogs, overlays, composed consumers, and state
all refer to them. Update the top-level `researched` date when evidence changes,
preserve uncertainty in `maybeReads`/notes, and never promote a path to confirmed
without a source or probe.

## Verification

```bash
cd cli
bun test test/registry.test.ts test/solver.test.ts
```

The TypeScript validator in `cli/src/registry.ts` is the executable schema.
